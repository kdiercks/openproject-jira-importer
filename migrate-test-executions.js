require("dotenv").config();
require("./logger");
const {
  getWorkPackagesByType,
  getWorkPackage,
  setParentWorkPackage,
  getRelationsForWorkPackage,
  createRelation,
  deleteRelation,
  getWorkPackageTypes,
  requireJiraIdField,
} = require("./openproject-client");
const { isXrayConfigured, getTestExecutionsByKeys } = require("./xray-client");

const DEFAULT_RELATION_TYPE = (
  process.env.OPENPROJECT_TEST_RELATION_TYPE || "includes"
).trim();
const REQUEST_DELAY_MS = parseInt(
  process.env.XRAY_REQUEST_DELAY_MS || "50",
  10
);

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getHrefId(href) {
  return href ? href.split("/").pop() : null;
}

function getParentId(workPackage) {
  return getHrefId(workPackage?._links?.parent?.href);
}

function relationConnects(relation, firstId, secondId) {
  const fromId = getHrefId(relation?._links?.from?.href);
  const toId = getHrefId(relation?._links?.to?.href);
  const first = String(firstId);
  const second = String(secondId);

  return (
    (fromId === first && toId === second) ||
    (fromId === second && toId === first)
  );
}

function getOtherEndpointId(relation, workPackageId) {
  const fromId = getHrefId(relation?._links?.from?.href);
  const toId = getHrefId(relation?._links?.to?.href);
  const id = String(workPackageId);

  if (fromId === id) return toId;
  if (toId === id) return fromId;
  return null;
}

function buildKeyMap(workPackages, jiraIdField) {
  const map = new Map();

  for (const workPackage of workPackages) {
    const key = workPackage[`customField${jiraIdField}`];
    if (!key) continue;

    if (!map.has(key)) {
      map.set(key, workPackage);
    } else {
      console.warn(
        `Duplicate Jira key ${key} in project (work packages ${map.get(key).id} and ${workPackage.id}); keeping the first`
      );
    }
  }

  return map;
}

function findType(types, name) {
  return types.find(
    (type) => type.name.toLowerCase() === name.toLowerCase()
  );
}

function createRelationCache() {
  const cache = new Map();

  return {
    async list(workPackageId) {
      const id = String(workPackageId);
      if (!cache.has(id)) {
        cache.set(id, await getRelationsForWorkPackage(id));
      }
      return cache.get(id);
    },
    add(relation, fromId, toId) {
      const synthetic = relation || {};
      synthetic._links = synthetic._links || {
        from: { href: `/api/v3/work_packages/${fromId}` },
        to: { href: `/api/v3/work_packages/${toId}` },
      };

      for (const id of [fromId, toId]) {
        const key = String(id);
        if (cache.has(key)) {
          cache.get(key).push(synthetic);
        }
      }
    },
  };
}

async function findCachedRelation(relationCache, firstId, secondId) {
  const relations = await relationCache.list(firstId);
  const found = relations.find((relation) =>
    relationConnects(relation, firstId, secondId)
  );
  if (found) return found;

  const reverseRelations = await relationCache.list(secondId);
  return (
    reverseRelations.find((relation) =>
      relationConnects(relation, firstId, secondId)
    ) || null
  );
}

async function ensureLink(options) {
  const {
    fromId,
    toId,
    type,
    verify,
    dryRun,
    relationCache,
  } = options;

  if (String(fromId) === String(toId)) {
    throw new Error("Cannot link a work package to itself");
  }

  const existing = await findCachedRelation(relationCache, fromId, toId);
  if (existing) {
    return { status: "exists", relation: existing };
  }

  if (verify) {
    return { status: "missing" };
  }

  if (dryRun) {
    return { status: "would-create" };
  }

  const relation = await createRelation(fromId, toId, type);
  relationCache.add(relation, fromId, toId);
  if (REQUEST_DELAY_MS > 0) {
    await delay(REQUEST_DELAY_MS);
  }

  return { status: "created", relation };
}

function createStats() {
  return {
    executions: 0,
    notFound: 0,
    testsExpected: 0,
    testsMissing: 0,
    linksExisting: 0,
    linksCreated: 0,
    linksMissing: 0,
    linksWouldCreate: 0,
    extraLinks: 0,
    pruned: 0,
    plansExpected: 0,
    plansMissing: 0,
    planParentsSet: 0,
    planParentsExisting: 0,
    planParentsWouldSet: 0,
    planParentsMissing: 0,
    planLinksExisting: 0,
    planLinksCreated: 0,
    planLinksMissing: 0,
    planLinksWouldCreate: 0,
    planConflicts: 0,
    multiPlanExecutions: 0,
    executionsWithoutPlan: 0,
    errors: 0,
  };
}

function countPlanLink(result, stats) {
  if (result.status === "exists") stats.planLinksExisting++;
  else if (result.status === "created") stats.planLinksCreated++;
  else if (result.status === "missing") stats.planLinksMissing++;
  else if (result.status === "would-create") stats.planLinksWouldCreate++;
}

async function processTestLinks(options) {
  const {
    execution,
    testKeys,
    testByKey,
    relationType,
    verify,
    dryRun,
    prune,
    stats,
    relationCache,
  } = options;

  const expectedTestIds = new Set();
  const executionRelations = await relationCache.list(execution.id);

  for (const testKey of testKeys) {
    const testWorkPackage = testByKey.get(testKey);

    if (!testWorkPackage) {
      stats.testsMissing++;
      console.log(`  MISSING Test work package for ${testKey}`);
      continue;
    }

    const testId = String(testWorkPackage.id);
    expectedTestIds.add(testId);

    const existing =
      executionRelations.find((relation) =>
        relationConnects(relation, execution.id, testWorkPackage.id)
      ) ||
      (await findCachedRelation(
        relationCache,
        execution.id,
        testWorkPackage.id
      ));

    if (existing) {
      stats.linksExisting++;
      continue;
    }

    if (verify) {
      stats.linksMissing++;
      console.log(`  MISSING link to ${testKey}`);
      continue;
    }

    if (dryRun) {
      stats.linksWouldCreate++;
      console.log(`  would link ${testKey}`);
      continue;
    }

    const relation = await createRelation(
      execution.id,
      testWorkPackage.id,
      relationType
    );
    relationCache.add(relation, execution.id, testWorkPackage.id);
    stats.linksCreated++;
    console.log(`  linked ${testKey}`);

    if (REQUEST_DELAY_MS > 0) {
      await delay(REQUEST_DELAY_MS);
    }
  }

  const allTestIds = new Set(
    [...testByKey.values()].map((workPackage) => String(workPackage.id))
  );

  for (const relation of executionRelations) {
    if (relation.type !== relationType) continue;

    const otherId = getOtherEndpointId(relation, execution.id);
    if (!otherId || !allTestIds.has(otherId)) continue;
    if (expectedTestIds.has(otherId)) continue;

    stats.extraLinks++;
    console.log(`  extra ${relationType} link to Test work package ${otherId}`);

    if (!verify && !dryRun && prune) {
      await deleteRelation(relation.id);
      stats.pruned++;
      console.log(`  pruned link ${relation.id}`);
    }
  }
}

async function processPlanLinks(options) {
  const {
    execution,
    planKeys,
    planByKey,
    relationType,
    verify,
    dryRun,
    stats,
    relationCache,
  } = options;

  const resolvedPlans = [];

  for (const planKey of planKeys) {
    const planWorkPackage = planByKey.get(planKey);

    if (!planWorkPackage) {
      stats.plansMissing++;
      console.log(`  MISSING Test Plan work package for ${planKey}`);
      continue;
    }

    resolvedPlans.push({ key: planKey, workPackage: planWorkPackage });
  }

  if (resolvedPlans.length === 0) {
    stats.executionsWithoutPlan++;
    return;
  }

  const currentParentId = getParentId(execution);

  if (resolvedPlans.length === 1) {
    const plan = resolvedPlans[0];
    const planId = String(plan.workPackage.id);

    if (currentParentId === planId) {
      stats.planParentsExisting++;
      return;
    }

    if (!currentParentId) {
      if (verify) {
        stats.planParentsMissing++;
        console.log(`  MISSING parent Test Plan ${plan.key}`);
        return;
      }

      if (dryRun) {
        stats.planParentsWouldSet++;
        console.log(`  would set parent Test Plan ${plan.key}`);
        return;
      }

      await setParentWorkPackage(execution.id, plan.workPackage.id);
      stats.planParentsSet++;
      console.log(`  set parent Test Plan ${plan.key}`);
      return;
    }

    stats.planConflicts++;
    console.log(
      `  existing parent ${currentParentId} differs from Test Plan ${plan.key}; using a relation instead`
    );

    const result = await ensureLink({
      fromId: plan.workPackage.id,
      toId: execution.id,
      type: relationType,
      verify,
      dryRun,
      relationCache,
    });
    countPlanLink(result, stats);
    if (result.status === "created") {
      console.log(`  linked Test Plan ${plan.key} by relation`);
    } else if (result.status === "missing") {
      console.log(`  MISSING relation to Test Plan ${plan.key}`);
    } else if (result.status === "would-create") {
      console.log(`  would link Test Plan ${plan.key} by relation`);
    }
    return;
  }

  stats.multiPlanExecutions++;
  const parentPlan = resolvedPlans.find(
    (plan) => String(plan.workPackage.id) === currentParentId
  );

  if (currentParentId && !parentPlan) {
    stats.planConflicts++;
    console.log(
      `  existing parent ${currentParentId} is not one of the Xray Test Plans; keeping it`
    );
  }

  for (const plan of resolvedPlans) {
    if (parentPlan && parentPlan.key === plan.key) {
      stats.planParentsExisting++;
      continue;
    }

    const result = await ensureLink({
      fromId: plan.workPackage.id,
      toId: execution.id,
      type: relationType,
      verify,
      dryRun,
      relationCache,
    });
    countPlanLink(result, stats);

    if (result.status === "created") {
      console.log(`  linked Test Plan ${plan.key} by relation`);
    } else if (result.status === "missing") {
      console.log(`  MISSING relation to Test Plan ${plan.key}`);
    } else if (result.status === "would-create") {
      console.log(`  would link Test Plan ${plan.key} by relation`);
    }
  }
}

async function processExecution(options) {
  const {
    execution,
    executionKey,
    xrayExecution,
    testByKey,
    planByKey,
    relationType,
    verify,
    dryRun,
    prune,
    planParents,
    stats,
  } = options;

  const executionDetail = await getWorkPackage(execution.id);
  const testKeys = xrayExecution.testKeys || [];
  const planKeys = xrayExecution.planKeys || [];

  stats.testsExpected += testKeys.length;
  stats.plansExpected += planKeys.length;

  console.log(
    `[${executionKey}] Xray: ${testKeys.length} test link(s), ${planKeys.length} plan(s)`
  );

  const relationCache = createRelationCache();

  await processTestLinks({
    execution: executionDetail,
    testKeys,
    testByKey,
    relationType,
    verify,
    dryRun,
    prune,
    stats,
    relationCache,
  });

  if (planParents) {
    await processPlanLinks({
      execution: executionDetail,
      planKeys,
      planByKey,
      relationType,
      verify,
      dryRun,
      stats,
      relationCache,
    });
  }
}

async function migrateTestExecutions(openProjectId, options = {}) {
  const {
    jiraProjectKey = null,
    issueKeys = null,
    limit = null,
    verify = false,
    dryRun = false,
    prune = false,
    planParents = true,
    relationType = DEFAULT_RELATION_TYPE,
  } = options;

  if (!isXrayConfigured()) {
    throw new Error(
      "XRAY_CLIENT_ID and XRAY_CLIENT_SECRET must be set in .env to fetch Xray test executions"
    );
  }

  const jiraIdField = requireJiraIdField();
  const types = await getWorkPackageTypes(openProjectId);
  const executionType = findType(types, "Test Execution");
  const testType = findType(types, "Test");
  const planType = findType(types, "Test Plan");

  if (!executionType) {
    throw new Error(
      `OpenProject type "Test Execution" is not available in project ${openProjectId}`
    );
  }

  if (!testType) {
    throw new Error(
      `OpenProject type "Test" is not available in project ${openProjectId}`
    );
  }

  if (planParents && !planType) {
    throw new Error(
      `OpenProject type "Test Plan" is not available in project ${openProjectId}`
    );
  }

  const executionWorkPackages = await getWorkPackagesByType(
    openProjectId,
    executionType.id
  );
  const testWorkPackages = await getWorkPackagesByType(
    openProjectId,
    testType.id
  );
  const planWorkPackages = planType
    ? await getWorkPackagesByType(openProjectId, planType.id)
    : [];

  const testByKey = buildKeyMap(testWorkPackages, jiraIdField);
  const planByKey = buildKeyMap(planWorkPackages, jiraIdField);
  const issueKeySet = issueKeys ? new Set(issueKeys) : null;

  const selectedExecutions = executionWorkPackages
    .map((workPackage) => ({
      workPackage,
      jiraKey: workPackage[`customField${jiraIdField}`],
    }))
    .filter(
      ({ jiraKey }) =>
        jiraKey &&
        (!jiraProjectKey || jiraKey.startsWith(`${jiraProjectKey}-`)) &&
        (!issueKeySet || issueKeySet.has(jiraKey))
    );

  const uniqueExecutions = [
    ...new Map(
      selectedExecutions.map((execution) => [
        execution.workPackage.id,
        execution,
      ])
    ).values(),
  ];
  const limitedExecutions = limit
    ? uniqueExecutions.slice(0, limit)
    : uniqueExecutions;

  console.log(
    `\nFound ${limitedExecutions.length} Test Execution work package(s) in project ${openProjectId}` +
      (jiraProjectKey ? ` for Jira project ${jiraProjectKey}` : "")
  );
  console.log(`Mapped ${testByKey.size} Test work package(s)`);
  console.log(`Mapped ${planByKey.size} Test Plan work package(s)`);
  console.log(`Relation type: ${relationType}`);

  if (limitedExecutions.length === 0) {
    return createStats();
  }

  console.log("Fetching test executions from Xray...");
  const xrayExecutions = await getTestExecutionsByKeys(
    limitedExecutions.map((execution) => execution.jiraKey)
  );

  const stats = createStats();

  for (const execution of limitedExecutions) {
    stats.executions++;
    const xrayExecution = xrayExecutions.get(execution.jiraKey);

    if (!xrayExecution) {
      stats.notFound++;
      console.log(`[${execution.jiraKey}] not found in Xray; skipped`);
      continue;
    }

    try {
      await processExecution({
        execution: execution.workPackage,
        executionKey: execution.jiraKey,
        xrayExecution,
        testByKey,
        planByKey,
        relationType,
        verify,
        dryRun,
        prune,
        planParents,
        stats,
      });
    } catch (error) {
      stats.errors++;
      console.error(`[${execution.jiraKey}] failed: ${error.message}`);
      if (error.response?.data) {
        console.error(
          "Error details:",
          JSON.stringify(error.response.data, null, 2)
        );
      }
    }
  }

  console.log("\n=== Test Execution Migration Summary ===");
  console.log(`Test Executions checked: ${stats.executions}`);
  console.log(`Test Executions not found in Xray: ${stats.notFound}`);
  console.log(`Xray Test links: ${stats.testsExpected}`);
  console.log(`Missing Test work packages: ${stats.testsMissing}`);
  console.log(`Existing Test links: ${stats.linksExisting}`);
  console.log(`Xray Test Plans: ${stats.plansExpected}`);
  console.log(`Missing Test Plan work packages: ${stats.plansMissing}`);
  console.log(`Plan parent conflicts: ${stats.planConflicts}`);
  console.log(
    `Executions with multiple plans: ${stats.multiPlanExecutions}`
  );
  console.log(
    `Executions without a plan association: ${stats.executionsWithoutPlan}`
  );

  if (verify) {
    console.log(`Missing Test links: ${stats.linksMissing}`);
    console.log(`Extra Test links: ${stats.extraLinks}`);
    console.log(`Missing plan parents: ${stats.planParentsMissing}`);
    console.log(`Missing plan relations: ${stats.planLinksMissing}`);
    console.log(`Errors: ${stats.errors}`);

    const failed =
      stats.notFound > 0 ||
      stats.testsMissing > 0 ||
      stats.linksMissing > 0 ||
      stats.extraLinks > 0 ||
      stats.plansMissing > 0 ||
      stats.planParentsMissing > 0 ||
      stats.planLinksMissing > 0 ||
      stats.errors > 0;

    console.log(
      failed
        ? "\nVerification found differences."
        : "\nVerification passed: all Xray execution links are present."
    );
    if (failed) process.exitCode = 1;
  } else {
    if (dryRun) {
      console.log(`Would create Test links: ${stats.linksWouldCreate}`);
      console.log(`Would set plan parents: ${stats.planParentsWouldSet}`);
      console.log(
        `Would create plan relations: ${stats.planLinksWouldCreate}`
      );
      if (prune) {
        console.log(`Would prune Test links: ${stats.extraLinks}`);
      } else if (stats.extraLinks > 0) {
        console.log(`Extra Test links: ${stats.extraLinks}`);
      }
    } else {
      console.log(`Created Test links: ${stats.linksCreated}`);
      console.log(`Set plan parents: ${stats.planParentsSet}`);
      console.log(`Created plan relations: ${stats.planLinksCreated}`);
      console.log(`Pruned Test links: ${stats.pruned}`);
    }
    console.log(`Errors: ${stats.errors}`);
  }

  console.log("=========================================\n");
  return stats;
}

function parseArgs(argv) {
  const options = {
    openProjectId: null,
    jiraProjectKey: null,
    issueKeys: null,
    limit: null,
    verify: false,
    dryRun: false,
    prune: false,
    planParents: true,
    relationType: DEFAULT_RELATION_TYPE,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === "--jira-project") {
      options.jiraProjectKey = argv[++i];
    } else if (arg === "--issues") {
      options.issueKeys = argv[++i]
        .split(",")
        .map((key) => key.trim())
        .filter(Boolean);
    } else if (arg === "--limit") {
      options.limit = parseInt(argv[++i], 10);
    } else if (arg === "--relation-type") {
      options.relationType = argv[++i];
    } else if (arg === "--no-plan-parents") {
      options.planParents = false;
    } else if (arg === "--verify") {
      options.verify = true;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--prune") {
      options.prune = true;
    } else if (/^\d+$/.test(arg) && options.openProjectId === null) {
      options.openProjectId = parseInt(arg, 10);
    } else {
      console.warn(`Ignoring unknown argument: ${arg}`);
    }
  }

  return options;
}

function printUsage() {
  console.log(
    "Usage: node migrate-test-executions.js OPENPROJECT_ID [--jira-project KEY] [--issues EXEC1,EXEC2] [--limit N] [--relation-type includes] [--no-plan-parents] [--verify] [--dry-run] [--prune]"
  );
  console.log("");
  console.log("Examples:");
  console.log(
    "  node migrate-test-executions.js 49 --jira-project PS --dry-run"
  );
  console.log(
    "  node migrate-test-executions.js 49 --jira-project PS --verify"
  );
  console.log("  node migrate-test-executions.js 49 --jira-project PS");
}

if (require.main === module) {
  const options = parseArgs(process.argv.slice(2));

  if (!options.openProjectId) {
    printUsage();
    process.exit(1);
  }

  migrateTestExecutions(options.openProjectId, options)
    .then(() => {
      if (process.exitCode === undefined) process.exitCode = 0;
    })
    .catch((error) => {
      console.error(`Test execution migration failed: ${error.message}`);
      process.exitCode = 1;
    });
}

module.exports = { migrateTestExecutions };
