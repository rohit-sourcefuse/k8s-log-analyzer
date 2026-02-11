'use strict';

const COLORS = ['#f85149','#d29922','#e3b341','#3fb950','#58a6ff','#bc8cff','#f778ba','#22d3ee','#e879f9','#84cc16','#8b949e','#6e7681'];

function buildErrorDistributionChart(categories) {
  const top = categories.slice(0, 10);
  return {
    type: 'doughnut',
    data: {
      labels: top.map(c => `${c.name.replace(/_/g,' ')} (${c.count.toLocaleString()})`),
      datasets: [{ data: top.map(c => c.count), backgroundColor: COLORS.slice(0, top.length), borderWidth: 0 }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { position: 'right', labels: { color: '#e6edf3', font: { size: 11 } } } }
    }
  };
}

function buildErrorTimelineChart(timeline, categories) {
  const topCats = categories.slice(0, 6).map(c => c.name);
  const labels = timeline.map(t => {
    const d = new Date(t.timestamp);
    return `${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')}`;
  });
  const datasets = topCats.map((cat, i) => ({
    label: cat.replace(/_/g, ' '),
    data: timeline.map(t => t.categories[cat] || 0),
    backgroundColor: COLORS[i]
  }));
  return {
    type: 'bar',
    data: { labels, datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      scales: {
        x: { stacked: true, ticks: { color: '#8b949e' }, grid: { display: false } },
        y: { stacked: true, ticks: { color: '#8b949e' }, grid: { color: '#21262d' } }
      },
      plugins: { legend: { labels: { color: '#e6edf3' } } }
    }
  };
}

function buildPodErrorChart(topPods) {
  const pods = topPods.slice(0, 12);
  return {
    type: 'bar',
    data: {
      labels: pods.map(p => p.name.length > 30 ? p.name.substring(0, 30) + '...' : p.name),
      datasets: [{ label: 'Log lines', data: pods.map(p => p.count), backgroundColor: pods.map((_, i) => COLORS[i % COLORS.length]) }]
    },
    options: {
      indexAxis: 'y', responsive: true, maintainAspectRatio: false,
      scales: {
        x: { ticks: { color: '#8b949e' }, grid: { color: '#21262d' } },
        y: { ticks: { color: '#8b949e', font: { size: 10 } }, grid: { display: false } }
      },
      plugins: { legend: { display: false } }
    }
  };
}

function buildNodeCpuChart(nodeTrends) {
  const entries = nodeTrends.cpu;
  if (entries.length === 0) return null;
  const labels = entries.map(e => {
    const d = new Date(e.timestamp);
    return `${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')}`;
  });
  const nodeNames = Object.keys(entries[0].nodes);
  const datasets = nodeNames.map((n, i) => ({
    label: n, data: entries.map(e => e.nodes[n] || 0),
    borderColor: COLORS[i % COLORS.length], fill: false, tension: 0.3, pointRadius: 3
  }));
  return {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      scales: {
        x: { ticks: { color: '#8b949e' }, grid: { display: false } },
        y: { title: { display: true, text: 'CPU %', color: '#8b949e' }, ticks: { color: '#8b949e' }, grid: { color: '#21262d' } }
      },
      plugins: { legend: { labels: { color: '#e6edf3', font: { size: 10 } } } }
    }
  };
}

function buildNodeMemoryChart(nodeTrends) {
  const entries = nodeTrends.memory;
  if (entries.length === 0) return null;
  const labels = entries.map(e => {
    const d = new Date(e.timestamp);
    return `${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')}`;
  });
  const nodeNames = Object.keys(entries[0].nodes);
  const datasets = nodeNames.map((n, i) => ({
    label: n, data: entries.map(e => e.nodes[n] || 0),
    borderColor: COLORS[i % COLORS.length], fill: false, tension: 0.3, pointRadius: 3
  }));
  return {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      scales: {
        x: { ticks: { color: '#8b949e' }, grid: { display: false } },
        y: { title: { display: true, text: 'Memory %', color: '#8b949e' }, ticks: { color: '#8b949e' }, grid: { color: '#21262d' } }
      },
      plugins: { legend: { labels: { color: '#e6edf3', font: { size: 10 } } } }
    }
  };
}

function buildHotPodCpuChart(podTrends, hotPods) {
  if (hotPods.length === 0) return null;
  const topDeployments = hotPods.slice(0, 5).map(h => h.deployment);
  const allTimestamps = new Set();

  for (const depl of topDeployments) {
    const points = podTrends.cpu[depl] || [];
    for (const p of points) {
      const d = new Date(p.timestamp);
      allTimestamps.add(`${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')}`);
    }
  }

  const labels = [...allTimestamps].sort();
  const datasets = topDeployments.map((depl, i) => {
    const points = podTrends.cpu[depl] || [];
    const byTs = {};
    for (const p of points) {
      const d = new Date(p.timestamp);
      const key = `${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')}`;
      if (!byTs[key]) byTs[key] = [];
      byTs[key].push(p.value);
    }
    const data = labels.map(l => {
      const vals = byTs[l];
      if (!vals) return null;
      return Math.max(...vals);
    });
    return {
      label: depl.length > 25 ? depl.substring(0, 25) + '...' : depl,
      data, borderColor: COLORS[i], fill: false, tension: 0.3, pointRadius: 4, spanGaps: true
    };
  });

  return {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      scales: {
        x: { ticks: { color: '#8b949e' }, grid: { display: false } },
        y: { title: { display: true, text: 'CPU (millicores)', color: '#8b949e' }, ticks: { color: '#8b949e' }, grid: { color: '#21262d' } }
      },
      plugins: { legend: { labels: { color: '#e6edf3', font: { size: 10 } } } }
    }
  };
}

function buildScalingChart(deploymentTimelines) {
  if (!deploymentTimelines || Object.keys(deploymentTimelines).length === 0) return null;
  const allTs = new Set();
  for (const points of Object.values(deploymentTimelines)) {
    for (const p of points) {
      const d = new Date(p.timestamp);
      allTs.add(`${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')}`);
    }
  }
  const labels = [...allTs].sort();
  const datasets = Object.entries(deploymentTimelines).map(([name, points], i) => {
    const byTs = {};
    for (const p of points) {
      const d = new Date(p.timestamp);
      byTs[`${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')}`] = p.desired;
    }
    return {
      label: name.length > 30 ? name.substring(0, 30) + '...' : name,
      data: labels.map(l => byTs[l] ?? null),
      borderColor: COLORS[i % COLORS.length], fill: false, tension: 0.3, pointRadius: 4, spanGaps: true
    };
  });
  return {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      scales: {
        x: { ticks: { color: '#8b949e' }, grid: { display: false } },
        y: { title: { display: true, text: 'Replica Count', color: '#8b949e' }, ticks: { color: '#8b949e', stepSize: 1 }, grid: { color: '#21262d' }, min: 0 }
      },
      plugins: { legend: { labels: { color: '#e6edf3' } } }
    }
  };
}

function buildDbConnectionChart(timeline) {
  if (!timeline || timeline.length === 0) return null;
  const labels = timeline.map(t => {
    const d = new Date(t.timestamp);
    return `${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')}:${String(d.getUTCSeconds()).padStart(2,'0')}`;
  });
  const step = Math.max(1, Math.floor(labels.length / 50));
  const sampledLabels = labels.filter((_, i) => i % step === 0);
  const sampledTotal = timeline.filter((_, i) => i % step === 0).map(t => t.total);
  const sampledActive = timeline.filter((_, i) => i % step === 0).map(t => t.active);

  return {
    type: 'line',
    data: {
      labels: sampledLabels,
      datasets: [
        { label: 'Total Connections', data: sampledTotal, borderColor: '#38bdf8', fill: false, tension: 0.3 },
        { label: 'Active Connections', data: sampledActive, borderColor: '#f87171', fill: false, tension: 0.3 }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      scales: {
        x: { ticks: { color: '#8b949e', maxTicksLimit: 20 }, grid: { display: false } },
        y: { ticks: { color: '#8b949e' }, grid: { color: '#21262d' } }
      },
      plugins: { legend: { labels: { color: '#e6edf3' } } }
    }
  };
}

module.exports = {
  buildErrorDistributionChart,
  buildErrorTimelineChart,
  buildPodErrorChart,
  buildNodeCpuChart,
  buildNodeMemoryChart,
  buildHotPodCpuChart,
  buildScalingChart,
  buildDbConnectionChart,
  COLORS
};
