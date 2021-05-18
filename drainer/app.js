"use strict";
const AWS = require("aws-sdk");
const EKS = require("aws-sdk/clients/eks");
const EC2 = require("aws-sdk/clients/ec2");
const ASG = require("aws-sdk/clients/autoscaling");
const ELBV2 = require("aws-sdk/clients/elbv2");
const pRetry = require("p-retry");
const Log = require("@dazn/lambda-powertools-logger");

const aws4 = require("aws4");
const eks = new EKS({ region: "eu-west-2" });
const autoscaling = new ASG();
const ec2 = new EC2();
const elbv2 = new ELBV2();

const credentialsProvider = new AWS.CredentialProviderChain();
const { Client, KubeConfig } = require("kubernetes-client");
const Request = require("kubernetes-client/backends/request");

async function initKubeClient(clusterName) {
  const kubeconfig = new KubeConfig();

  if (process.env.NODE_ENV === "inCluster") {
    kubeconfig.loadFromCluster();
  } else {
    kubeconfig.loadFromString(JSON.stringify(await getKubeConfig(clusterName)));
  }

  const backend = new Request({ kubeconfig });
  const kubeclient = new Client({ backend });

  await kubeclient.loadSpec();

  return kubeclient;
}

async function nodeNotExists(client, nodeName) {
  //Determines whether the specified node is still part of the cluster.
  const nodes = await client.api.v1.nodes.get();
  const node = nodes.body.items.find((o) => o.metadata.name === nodeName);
  return node === undefined;
}

async function cordonNode(client, nodeName) {
  // Marks the specified node as unschedulable, which means that no new pods can be launched on the
  // node by the Kubernetes scheduler.
  const patch_body = {
    spec: {
      unschedulable: true,
    },
  };
  await client.api.v1.nodes(nodeName).patch({ body: patch_body });
}

async function getBearerToken(name) {
  const credentials = await credentialsProvider.resolvePromise();

  const sts = {
    host: `sts.amazonaws.com`,
    path: `/?Action=GetCallerIdentity&Version=2011-06-15&X-Amz-Expires=60`,
    headers: {
      "x-k8s-aws-id": name,
    },
    signQuery: true,
  };
  aws4.sign(sts, credentials);

  const signed = `https://${sts.host}${sts.path}`;
  return (
    "k8s-aws-v1." +
    Buffer.from(signed.toString(), "binary")
      .toString("base64")
      .replace(/=+$/, "")
      .replace("+", "-")
      .replace("/", "_")
  );
}

async function completeLifecycleAction(eventDetail) {
  const {
    AutoScalingGroupName,
    LifecycleActionToken,
    LifecycleHookName,
  } = eventDetail;
  await autoscaling
    .completeLifecycleAction({
      AutoScalingGroupName,
      LifecycleActionResult: "CONTINUE",
      LifecycleActionToken,
      LifecycleHookName,
    })
    .promise();
}

async function getKubeConfig(name) {
  const clusterDetails = await eks.describeCluster({ name }).promise();
  const token = await getBearerToken(name);
  const stgs = {
    apiVersion: "v1",
    clusters: [
      {
        cluster: {
          "certificate-authority-data":
            clusterDetails.cluster.certificateAuthority.data,
          server: clusterDetails.cluster.endpoint,
        },
        name: "cluster",
      },
    ],
    contexts: [
      {
        context: {
          cluster: "cluster",
          user: "cluster",
        },
        name: "cluster",
      },
    ],
    "current-context": "cluster",
    kind: "Config",
    preferences: {},
    users: [
      {
        name: "cluster",
        user: {
          token,
        },
      },
    ],
  };
  return stgs;
}

async function podsToEvict(client, nodeName) {
  const pods = (
    await client.api.v1.pods.get({
      qs: {
        fieldSelector: `spec.nodeName=${nodeName},metadata.namespace!=kube-system`,
      },
    })
  ).body.items;

  return pods.filter(
    (pod) => pod.metadata.ownerReferences[0].kind !== "DaemonSet"
  );
}
async function pollUntilAllPodsRemoved(client, nodeName) {
  const pods = await podsToEvict(client, nodeName);
  // Abort retrying if the resource doesn't exist
  console.log(`still waiting for ${pods.length} pods to be evicted`);
  if (pods.length > 0) {
    throw new Error(`still waiting for ${pods.length} pods to be evicted`);
  }
}
async function removeAllPods(client, nodeName) {
  //"""Removes all Kubernetes pods from the specified node."""
  //pods = get_evictable_pods(client, nodeName)

  const pods = await podsToEvict(client, nodeName);
  await Promise.all(
    pods.map(async (pod) => {
      // we need to use the eviction api
      const namespace = pod.metadata.namespace;
      const name = pod.metadata.name;
      console.log(`attempting to evict: ${name}`);
      //console.log(await client.api.v1.namespaces(namespace).pods(name).get());
      const eviction = {
        apiVersion: "policy/v1beta1",
        kind: "Eviction",
        metadata: {
          name,
          namespace,
        },
      };
      evictPod(client, eviction, name, namespace, 0);
    })
  );
}

async function pollUntilAllPodsStable(client, nodeName) {
  const pods = await podsToEvict(client, nodeName);
  // Abort retrying if the resource doesn't exist
  console.log(`still waiting for ${pods.length} pods to be evicted`);
  if (pods.length > 0) {
    throw new Error(`still waiting for ${pods.length} pods to be evicted`);
  }
}

async function evictPod(client, eviction, name, namespace, retry) {
  try {
    await client.api.v1
      .namespaces(namespace)
      .pods(name)
      .eviction.post({ body: eviction });
  } catch (error) {
    // only retry if the pod exists and we hanve hit the retry limit
    if (retry < 10 && error.statusCode != 404) {
      Log.info("unable to evict Pod", { error, namespace, name });
      await new Promise((resolve) => setTimeout(resolve, 10000));
      evictPod(client, eviction, name, namespace, retry);
      retry = retry + 1;
    }
    Log.error("unable to evict Pod", { error, namespace, name });
  }
}

exports.lambdaHandler = async (event, context) => {

  // event.detail.EC2InstanceId - instance termination event
  // event.detail['instance-id'] - spot instance event
  const instanceId = event.detail.EC2InstanceId || event.detail['instance-id'];
  Log.debug("event", { event, instanceId });

  // what happens if this doesnt exist
  const instances = await ec2
    .describeInstances({
      InstanceIds: [instanceId],
    })
    .promise();
  Log.debug("response when describing instance", { instances });

  const nodeName = instances.Reservations[0].Instances[0].PrivateDnsName;
  const clusterName = instances.Reservations[0].Instances[0].Tags.find(
    ({ Key }) => (Key === "KubernetesCluster")
  ).Value;

  Log.info("node and cluster info", {
    details: { instanceId, nodeName, clusterName },
  });

  //check node exists
  if (clusterName) {
    // autoscaling event has nothing to do with us as it doesn't exist in the cluster
    return {
      statusCode: 200,
      body: "Node does not exist in cluster",
    };
  }

  // deregister the node from the target groups provided
  if (process.env.targetGroup) {
    console.log(`target group, ${process.env.targetGroup}`);

    var params = {
      TargetGroupArn: process.env.targetGroup,
      Targets: [
        {
          Id: instanceId,
        },
      ],
    };
    try {
      console.log(await elbv2.deregisterTargets(params).promise());
    } catch (e) {
      console.log(`deregisterTarget failure: ${e}`);
    }
  }

  const kubeClient = await initKubeClient(clusterName);

  // arn:aws:elasticloadbalancing:eu-west-2:337889762567:targetgroup/eks-internal-api-nlb-eks-test-tg/d54db6fbdfbcf805
  await cordonNode(kubeClient, nodeName);

  await removeAllPods(kubeClient, nodeName);

  await pRetry(() => pollUntilAllPodsRemoved(kubeClient, nodeName), {
    onFailedAttempt: (error) => {
      console.log(
        `attempt ${error.attemptNumber} failed. There are ${error.retriesLeft} retries left.`
      );
    },
    retries: 20,
  });

  console.log("Complete Lifecycle Action: " + instanceId);
  await completeLifecycleAction(event.detail);

  // //console.log(JSON.stringify(res, null, 2));

  return {
    statusCode: 200,
    //  body: JSON.stringify(res.body, null, 2),
  };
};
