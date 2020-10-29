"use strict";
const AWS = require("aws-sdk");
const EKS = require("aws-sdk/clients/eks");
const EC2 = require("aws-sdk/clients/ec2");
const ASG = require("aws-sdk/clients/autoscaling");
const pRetry = require("p-retry");

const aws4 = require("aws4");
const eks = new EKS({ region: "eu-west-2" });
var autoscaling = new ASG();
const ec2 = new EC2();

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
      await client.api.v1
        .namespaces(namespace)
        .pods(name)
        .eviction.post({ body: eviction });
    })
  );
}

exports.lambdaHandler = async (event, context) => {
    // get the cluster name from the tag on the autoscaling group
  const asgTags = await autoscaling
    .describeTags({
      Filters: [
        {
          Name: "auto-scaling-group",
          Values: [event.detail.AutoScalingGroupName],
        },
      ],
    })
    .promise();
  const clusterName = asgTags.Tags.filter((word) =>
    word.Key.startsWith("kubernetes.io/cluster/")
  )[0].Key.replace("kubernetes.io/cluster/", "");

  console.log("Cluster Name: " + clusterName);
  //const kubeClient = await getKubeClient("nonprod-1");
  const kubeClient = await initKubeClient(clusterName);
  //await kubeClient.patchNodeStatus('sdf','{"spec":{"unschedulable":true}}')

  const instanceId = event.detail.EC2InstanceId;
  console.log("Instance ID: " + instanceId);
  // what happens if this doesnt exist
  const instances = await ec2
    .describeInstances({
      InstanceIds: [instanceId],
    })
    .promise();

  const nodeName = instances.Reservations[0].Instances[0].PrivateDnsName;
  // console.log("nodeName: " + nodeName);

  //check node exists
  if (await nodeNotExists(kubeClient, nodeName)) {
    // autoscaling event has nothing to do with us as it doesn't exist in the cluster
    return {
      statusCode: 200,
      body: "Node does not exist in cluster",
    };
  }

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

  console.log('Complete Lifecycle Action: ' + instanceId)
  await completeLifecycleAction(event.detail);

  // //console.log(JSON.stringify(res, null, 2));

  return {
    statusCode: 200,
    //  body: JSON.stringify(res.body, null, 2),
  };

  // Use this code if you don't use the http event with the LAMBDA-PROXY integration
  // return { message: 'Go Serverless v1.0! Your function executed successfully!', event };
};
