'use strict';

function generateRecommendations(issues) {
  const recommendations = [];
  let idx = 0;

  const severityPriority = { critical: 10, high: 7, medium: 4, low: 2 };

  for (const issue of issues) {
    const basePriority = severityPriority[issue.severity] || 1;

    recommendations.push({
      priority: basePriority,
      category: inferCategory(issue),
      action: issue.action || `Investigate: ${issue.title}`,
      rationale: issue.impact || issue.description,
      effort: inferEffort(issue),
      impact: issue.severity === 'critical' || issue.severity === 'high' ? 'high' : issue.severity === 'medium' ? 'medium' : 'low',
      relatedIssue: issue.id
    });
  }

  recommendations.sort((a, b) => b.priority - a.priority);

  return { recommendations };
}

function inferCategory(issue) {
  const title = (issue.title || '').toLowerCase();
  if (/redis|kafka|db|database|connection/i.test(title)) return 'infrastructure';
  if (/config|mysql2|timezone/i.test(title)) return 'configuration';
  if (/nlu|fallback|training/i.test(title)) return 'ml-model';
  if (/cpu|memory|oom|scaling/i.test(title)) return 'resources';
  if (/5xx|timeout|crash/i.test(title)) return 'reliability';
  return 'general';
}

function inferEffort(issue) {
  const action = (issue.action || '').toLowerCase();
  if (/check|verify|review|investigate/i.test(action)) return 'low';
  if (/update|change|increase|add/i.test(action)) return 'medium';
  if (/redesign|migrate|refactor/i.test(action)) return 'high';
  return 'medium';
}

module.exports = { generateRecommendations };
