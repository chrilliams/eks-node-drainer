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
  const { AutoScalingGroupName, LifecycleActionToken, LifecycleHookName } =
    eventDetail;
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
        fieldSelector: `spec.nodeName=${nodeName}`,
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
  Log.debug("still evicting pods", { remaining: pods.length });
  if (pods.length > 0) {
    throw new Error(`still waiting for ${pods.length} pods to be evicted`);
  }
}
async function removeAllPods(client, nodeName) {
  //"""Removes all Kubernetes pods from the specified node."""
  const pods = await podsToEvict(client, nodeName);
  await Promise.all(
    pods.map(async (pod) => {
      // we need to use the eviction api
      const namespace = pod.metadata.namespace;
      const name = pod.metadata.name;
      const eviction = {
        apiVersion: "policy/v1beta1",
        kind: "Eviction",
        metadata: {
          name,
          namespace,
        },
      };
      await evictPod(client, eviction, name, namespace, 0);
    })
  );
}

async function evictPod(client, eviction, name, namespace, retry) {
  try {
    Log.debug("attempting to evict", { eviction, name, namespace, retry });
    await client.api.v1
      .namespaces(namespace)
      .pods(name)
      .eviction.post({ body: eviction });
  } catch (error) {
    // only retry if the pod exists and we hanve hit the retry limit
    if (retry < 10 && error.statusCode != 404) {
      Log.info("unable to evict Pod", { error, namespace, name });
      await new Promise((resolve) => setTimeout(resolve, 10000));
      await evictPod(client, eviction, name, namespace, retry);
      retry = retry + 1;
    }
    Log.error("unable to evict Pod", { error, namespace, name });
  }
}

exports.lambdaHandler = async (event, context) => {
  // event.detail.EC2InstanceId - instance termination event
  // event.detail['instance-id'] - spot instance event
  const instanceId = event.detail.EC2InstanceId || event.detail["instance-id"];
  Log.debug("event", { event });
  Log.info("instanceId", { instanceId });

  // we can only continue with draining nodes if there is a lifecycle event
  // this is because we rely on AWS to correctly shutdown the node when the Lifecycle event successfully completes
  if (!event.detail.LifecycleActionToken) {
    Log.debug("no LifecycleActionToken");
    const terminateInstanceInAutoScalingGroupResponse = await autoscaling.terminateInstanceInAutoScalingGroup({ InstanceId: instanceId, ShouldDecrementDesiredCapacity: false }).promise();
    Log.debug("terminateInstanceInAutoScalingGroupResponse", terminateInstanceInAutoScalingGroupResponse)
    return
  }


  const instances = await ec2
    .describeInstances({
      InstanceIds: [instanceId],
    })
    .promise();
  Log.debug("response when describing instance", { instances });

  const nodeName = instances.Reservations[0].Instances[0].PrivateDnsName;
  const clusterName = instances.Reservations[0].Instances[0].Tags.find(
    ({ Key }) => Key === "KubernetesCluster"
  ).Value;

  Log.info("node and cluster info", {
    details: { instanceId, nodeName, clusterName },
  });

  const kubeClient = await initKubeClient(clusterName);

  //check node exists
  if (await nodeNotExists(kubeClient, nodeName)) {
    // autoscaling event has nothing to do with us as it doesn't exist in the cluster
    return {
      statusCode: 200,
      body: "Node does not exist in cluster",
    };
  }

  // deregister the node from the target groups provided
  if (process.env.targetGroup) {
    var params = {
      TargetGroupArn: process.env.targetGroup,
      Targets: [
        {
          Id: instanceId,
        },
      ],
    };
    try {
      const response = await elbv2.deregisterTargets(params).promise();
      Log.info("deregisterTarget", {
        details: {
          instanceId,
          nodeName,
          clusterName,
          targetGroupArn: process.env.targetGroup,
          response,
        },
      });
    } catch (e) {
      Log.error("deregisterTarget failed", {
        details: {
          instanceId,
          nodeName,
          clusterName,
          TargetGroupArn: process.env.targetGroup,
        },
      });
    }
  }

  await cordonNode(kubeClient, nodeName);

  await removeAllPods(kubeClient, nodeName);

  await pRetry(() => pollUntilAllPodsRemoved(kubeClient, nodeName), {
    onFailedAttempt: (error) => {
      Log.debug("pollUntilAllPodsRemovedFailed", {
        details: {
          instanceId,
          nodeName,
          clusterName,
          attempt: error.attemptNumber,
          retriesLeft: error.retriesLeft,
        },
      });
    },
    retries: 20,
  });

  try {
    Log.info("Complete Lifecycle Action", { instanceId });
    await completeLifecycleAction(event.detail);
  } catch (error) {
    // check to see if its retryable
    Log.error('Complete Lifecycle Action', {error})
  }

  return {
    statusCode: 200,
  };
};
