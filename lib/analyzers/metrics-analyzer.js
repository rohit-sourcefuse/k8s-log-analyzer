'use strict';

const { extractDeploymentName } = require('../parsers/parser-utils');

function analyzeMetrics(snapshots) {
  if (!snapshots || snapshots.length === 0) {
    return { nodeTrends: { cpu: [], memory: [] }, podTrends: { cpu: {}, memory: {} }, scalingEvents: [], hotPods: [], utilizationStats: {}, nodeAlerts: [] };
  }

  const nodeCpu = [];
  const nodeMemory = [];
  const podCpuByDeployment = {};
  const podMemByDeployment = {};
  const scalingEvents = [];
  const nodeAlerts = [];

  let prevDeployments = {};

  for (const snap of snapshots) {
    const ts = snap.timestamp;

    const cpuEntry = { timestamp: ts, nodes: {} };
    const memEntry = { timestamp: ts, nodes: {} };
    for (const node of snap.nodes) {
      const shortName = node.name.split('.')[0].replace('ip-', '');
      cpuEntry.nodes[shortName] = node.cpuPercent;
      memEntry.nodes[shortName] = node.memoryPercent;

      if (node.cpuPercent > 80) {
        nodeAlerts.push({ timestamp: ts, node: shortName, type: 'high_cpu', value: node.cpuPercent });
      }
      if (node.memoryPercent > 80) {
        nodeAlerts.push({ timestamp: ts, node: shortName, type: 'high_memory', value: node.memoryPercent });
      }
    }
    nodeCpu.push(cpuEntry);
    nodeMemory.push(memEntry);

    for (const pod of snap.pods) {
      const depl = extractDeploymentName(pod.name);
      if (!podCpuByDeployment[depl]) podCpuByDeployment[depl] = [];
      if (!podMemByDeployment[depl]) podMemByDeployment[depl] = [];
      podCpuByDeployment[depl].push({ timestamp: ts, pod: pod.name, value: pod.cpuMillicores });
      podMemByDeployment[depl].push({ timestamp: ts, pod: pod.name, value: pod.memoryMi });
    }

    for (const depl of snap.deployments) {
      const prev = prevDeployments[depl.name];
      if (prev && prev.desired !== depl.desired) {
        scalingEvents.push({
          timestamp: ts,
          deployment: depl.name,
          from: prev.desired,
          to: depl.desired
        });
      }
    }
    prevDeployments = {};
    for (const d of snap.deployments) prevDeployments[d.name] = d;
  }

  const hotPods = Object.entries(podCpuByDeployment)
    .map(([name, dataPoints]) => {
      const values = dataPoints.map(d => d.value).filter(v => v !== null);
      if (values.length === 0) return null;
      const avg = Math.round(values.reduce((s, v) => s + v, 0) / values.length);
      const max = Math.max(...values);
      return { deployment: name, avgCpu: avg, maxCpu: max, dataPoints: values.length };
    })
    .filter(Boolean)
    .sort((a, b) => b.maxCpu - a.maxCpu)
    .slice(0, 10);

  const allNodeCpus = snapshots.flatMap(s => s.nodes.map(n => n.cpuPercent)).filter(v => v !== null);
  const allNodeMems = snapshots.flatMap(s => s.nodes.map(n => n.memoryPercent)).filter(v => v !== null);

  const utilizationStats = {
    avgNodeCpu: allNodeCpus.length > 0 ? Math.round(allNodeCpus.reduce((s, v) => s + v, 0) / allNodeCpus.length) : 0,
    peakNodeCpu: allNodeCpus.length > 0 ? Math.max(...allNodeCpus) : 0,
    avgNodeMemory: allNodeMems.length > 0 ? Math.round(allNodeMems.reduce((s, v) => s + v, 0) / allNodeMems.length) : 0,
    peakNodeMemory: allNodeMems.length > 0 ? Math.max(...allNodeMems) : 0
  };

  const deploymentTimelines = {};
  for (const snap of snapshots) {
    for (const depl of snap.deployments) {
      if (!deploymentTimelines[depl.name]) deploymentTimelines[depl.name] = [];
      deploymentTimelines[depl.name].push({ timestamp: snap.timestamp, desired: depl.desired, ready: depl.ready });
    }
  }

  return {
    nodeTrends: { cpu: nodeCpu, memory: nodeMemory },
    podTrends: { cpu: podCpuByDeployment, memory: podMemByDeployment },
    scalingEvents,
    hotPods,
    utilizationStats,
    nodeAlerts,
    deploymentTimelines
  };
}

module.exports = { analyzeMetrics };
