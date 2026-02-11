'use strict';

const { bucketByInterval } = require('../utils/time-utils');
const { ERROR_PATTERNS } = require('../parsers/error-log-parser');

function classifyErrors(events) {
  const categories = {};
  const byPod = {};
  const byBot = {};

  for (const pattern of ERROR_PATTERNS) {
    categories[pattern.name] = {
      count: 0,
      severity: pattern.severity,
      affectedPods: new Set(),
      affectedDeployments: new Set(),
      affectedBots: new Set(),
      samples: [],
    };
  }
  categories['uncategorized'] = { count: 0, severity: 1, affectedPods: new Set(), affectedDeployments: new Set(), affectedBots: new Set(), samples: [] };

  for (const evt of events) {
    for (const cat of evt.categories) {
      if (!categories[cat]) {
        categories[cat] = { count: 0, severity: 1, affectedPods: new Set(), affectedDeployments: new Set(), affectedBots: new Set(), samples: [] };
      }
      const c = categories[cat];
      c.count++;
      if (evt.pod) c.affectedPods.add(evt.pod);
      if (evt.deployment) c.affectedDeployments.add(evt.deployment);
      if (evt.botId) c.affectedBots.add(evt.botId);
      if (c.samples.length < 5) c.samples.push(evt);
    }

    const podKey = evt.pod || 'unknown';
    if (!byPod[podKey]) byPod[podKey] = { count: 0, categories: {} };
    byPod[podKey].count++;
    for (const cat of evt.categories) {
      byPod[podKey].categories[cat] = (byPod[podKey].categories[cat] || 0) + 1;
    }

    if (evt.botId) {
      if (!byBot[evt.botId]) byBot[evt.botId] = { count: 0, categories: {}, pods: new Set() };
      byBot[evt.botId].count++;
      if (evt.pod) byBot[evt.botId].pods.add(evt.pod);
      for (const cat of evt.categories) {
        byBot[evt.botId].categories[cat] = (byBot[evt.botId].categories[cat] || 0) + 1;
      }
    }
  }

  const fiveMinMs = 5 * 60 * 1000;
  const buckets = bucketByInterval(events, fiveMinMs);
  const timeline = buckets.map(b => {
    const catCounts = {};
    for (const evt of b.events) {
      for (const cat of evt.categories) {
        catCounts[cat] = (catCounts[cat] || 0) + 1;
      }
    }
    return { timestamp: b.timestamp, categories: catCounts, total: b.events.length };
  });

  const sortedCategories = Object.entries(categories)
    .filter(([, v]) => v.count > 0)
    .sort((a, b) => b[1].count - a[1].count)
    .map(([name, data]) => ({
      name,
      count: data.count,
      severity: data.severity,
      affectedPods: [...data.affectedPods],
      affectedDeployments: [...data.affectedDeployments],
      affectedBots: [...data.affectedBots],
      samples: data.samples.map(s => ({ timestamp: s.timestamp, message: s.message, pod: s.pod }))
    }));

  const topPods = Object.entries(byPod)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 20)
    .map(([name, data]) => ({ name, count: data.count, categories: data.categories }));

  const topBots = Object.entries(byBot)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 20)
    .map(([id, data]) => ({ id, count: data.count, categories: data.categories, pods: [...data.pods] }));

  return { categories: sortedCategories, timeline, topPods, topBots };
}

module.exports = { classifyErrors };
