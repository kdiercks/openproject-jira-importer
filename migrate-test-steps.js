require("dotenv").config();
require("./logger");
const {
  getWorkPackagesByType,
  getWorkPackage,
  createWorkPackage,
  updateWorkPackage,
  deleteWorkPackage,
  setParentWorkPackage,
  getWorkPackageTypes,
  requireJiraIdField,
} = require("./openproject-client");
const { isXrayConfigured, getTestsByKeys } = require("./xray-client");

const ACTION_FIELD = parseInt(
  process.env.OPENPROJECT_TEST_STEP_ACTION_FIELD || "24",
  10
);
const EXPECTED_FIELD = parseInt(
  process.env.OPENPROJECT_TEST_STEP_EXPECTED_FIELD || "25",
  10
);
const DATA_FIELD = parseInt(
  process.env.OPENPROJECT_TEST_STEP_DATA_FIELD || "26",
  10
);
const REQUEST_DELAY_MS = parseInt(
  process.env.XRAY_REQUEST_DELAY_MS || "50",
  10
);

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getCustomFieldText(workPackage, fieldId) {
  const value = workPackage[`customField${fieldId}`];
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "object") {
    return value.raw || value.html || "";
  }
  return String(value);
}

function normalize(value) {
  return (value || "").replace(/\r\n/g, "\n").trim();
}

function getStepIndex(subject, jiraKey) {
  const prefix = `${jiraKey} - Step `;
  if (!subject || !subject.startsWith(prefix)) return null;
  const index = parseInt(subject.slice(prefix.length), 10);
  return Number.isInteger(index) && index > 0 ? index : null;
}

function getChildren(workPackage) {
  return (workPackage._links?.children || [])
    .map((child) => {
      const id = child.href ? parseInt(child.href.split("/").pop(), 10) : null;
      return id ? { id, title: child.title } : null;
    })
    .filter(Boolean);
}

function buildStepFields(step) {
  return {
    [`customField${ACTION_FIELD}`]: { raw: step.action || "" },
    [`customField${EXPECTED_FIELD}`]: { raw: step.result || "" },
    [`customField${DATA_FIELD}`]: { raw: step.data || "" },
  };
}

function isManualTest(xrayTest) {
  const kind = xrayTest?.testType?.kind;
  if (!kind) return true;

  const normalizedKind = kind.toLowerCase();
  return normalizedKind === "manual" || normalizedKind === "steps";
}

function createStats() {
  return {
    tests: 0,
    testsWithSteps: 0,
    testsWithoutSteps: 0,
    skippedNonManual: 0,
    notFound: 0,
    expectedSteps: 0,
    existingSteps: 0,
    created: 0,
    updated: 0,
    pruned: 0,
    missing: 0,
    extra: 0,
    mismatched: 0,
    emptyXray: 0,
    emptyOpenProject: 0,
    errors: 0,
  };
}

async function processTest({
  openProjectId,
  testWorkPackage,
  jiraKey,
  xrayTest,
  stepTypeId,
  verify,
  dryRun,
  prune,
  stats,
}) {
  const testDetail = await getWorkPackage(testWorkPackage.id);
  const children = getChildren(testDetail);
  const existingByIndex = new Map();

  for (const child of children) {
    const index = getStepIndex(child.title, jiraKey);
    if (index !== null && !existingByIndex.has(index)) {
      existingByIndex.set(index, child);
    }
  }

  const steps = xrayTest.steps || [];
  stats.expectedSteps += steps.length;
  stats.existingSteps += existingByIndex.size;

  let created = 0;
  let updated = 0;
  let pruned = 0;

  if (steps.length === 0) {
    stats.testsWithoutSteps++;
    console.log(`[${jiraKey}] no Xray steps (test type: ${xrayTest.testType?.kind || "unknown"})`);
  } else {
    stats.testsWithSteps++;
    console.log(
      `[${jiraKey}] Xray: ${steps.length} step(s), OpenProject: ${existingByIndex.size} step(s)`
    );
  }

  for (let i = 0; i < steps.length; i++) {
    const index = i + 1;
    const step = steps[i];
    const subject = `${jiraKey} - Step ${index}`;
    const existing = existingByIndex.get(index);
    const isEmpty =
      !normalize(step.action) &&
      !normalize(step.result) &&
      !normalize(step.data);

    if (isEmpty) {
      stats.emptyXray++;
    }

    if (verify) {
      if (!existing) {
        stats.missing++;
        console.log(`  MISSING step ${index}`);
        continue;
      }

      const existingDetail = await getWorkPackage(existing.id);
      const action = normalize(getCustomFieldText(existingDetail, ACTION_FIELD));
      const expected = normalize(
        getCustomFieldText(existingDetail, EXPECTED_FIELD)
      );
      const data = normalize(getCustomFieldText(existingDetail, DATA_FIELD));

      if (!action && !expected) {
        stats.emptyOpenProject++;
      }

      const mismatches = [];
      if (action !== normalize(step.action)) mismatches.push("action");
      if (expected !== normalize(step.result)) mismatches.push("expected");
      if (data !== normalize(step.data)) mismatches.push("data");

      if (mismatches.length > 0) {
        stats.mismatched++;
        console.log(`  MISMATCH step ${index}: ${mismatches.join(", ")}`);
      }
      continue;
    }

    const fields = buildStepFields(step);

    if (dryRun) {
      if (existing) {
        stats.updated++;
        updated++;
        console.log(`  would update step ${index}`);
      } else {
        stats.created++;
        created++;
        console.log(`  would create step ${index}`);
      }
      continue;
    }

    if (existing) {
      await updateWorkPackage(existing.id, fields);
      stats.updated++;
      updated++;
    } else {
      const createdWorkPackage = await createWorkPackage(openProjectId, {
        _type: "WorkPackage",
        subject,
        description: { raw: "" },
        ...fields,
        _links: {
          type: { href: `/api/v3/types/${stepTypeId}` },
        },
      });
      await setParentWorkPackage(createdWorkPackage.id, testWorkPackage.id);
      stats.created++;
      created++;
    }

    if (REQUEST_DELAY_MS > 0) {
      await delay(REQUEST_DELAY_MS);
    }
  }

  const extraIndexes = [...existingByIndex.keys()].filter(
    (index) => index > steps.length
  );
  stats.extra += extraIndexes.length;

  if (extraIndexes.length > 0) {
    console.log(
      `  extra step(s) in OpenProject: ${extraIndexes.sort((a, b) => a - b).join(", ")}`
    );

    if (!verify && !dryRun && prune) {
      for (const index of extraIndexes) {
        const child = existingByIndex.get(index);
        await deleteWorkPackage(child.id);
        stats.pruned++;
        pruned++;
        console.log(`  deleted extra step ${index}`);
      }
    }
  }

  if (!verify) {
    if (created || updated || pruned) {
      console.log(
        `  created: ${created}, updated: ${updated}, pruned: ${pruned}`
      );
    }
  }
}

async function migrateTestSteps(openProjectId, options = {}) {
  const {
    jiraProjectKey = null,
    issueKeys = null,
    typeNames = ["Test"],
    limit = null,
    verify = false,
    dryRun = false,
    prune = false,
  } = options;

  if (!isXrayConfigured()) {
    throw new Error(
      "XRAY_CLIENT_ID and XRAY_CLIENT_SECRET must be set in .env to fetch Xray test steps"
    );
  }

  const jiraIdField = requireJiraIdField();
  const types = await getWorkPackageTypes(openProjectId);
  const stepType = types.find(
    (type) => type.name.toLowerCase() === "test step"
  );

  if (!stepType) {
    throw new Error(
      `OpenProject type "Test Step" is not available in project ${openProjectId}`
    );
  }

  const normalizedTypeNames = typeNames.map((name) => name.toLowerCase());
  const testTypeIds = types
    .filter((type) => normalizedTypeNames.includes(type.name.toLowerCase()))
    .map((type) => type.id);

  if (testTypeIds.length === 0) {
    throw new Error(
      `None of the work package types [${typeNames.join(", ")}] exist in project ${openProjectId}`
    );
  }

  let testWorkPackages = [];
  for (const typeId of testTypeIds) {
    const workPackages = await getWorkPackagesByType(openProjectId, typeId);
    testWorkPackages = testWorkPackages.concat(workPackages);
  }

  const issueKeySet = issueKeys ? new Set(issueKeys) : null;
  const tests = testWorkPackages
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

  const uniqueTests = [...new Map(tests.map((test) => [test.workPackage.id, test])).values()];
  const selectedTests = limit ? uniqueTests.slice(0, limit) : uniqueTests;

  console.log(
    `\nFound ${selectedTests.length} test work package(s) in project ${openProjectId}` +
      (jiraProjectKey ? ` for Jira project ${jiraProjectKey}` : "")
  );

  if (selectedTests.length === 0) {
    return createStats();
  }

  console.log("Fetching test steps from Xray...");
  const xrayTests = await getTestsByKeys(
    selectedTests.map((test) => test.jiraKey)
  );

  const stats = createStats();

  for (const test of selectedTests) {
    stats.tests++;
    const xrayTest = xrayTests.get(test.jiraKey);

    if (!xrayTest) {
      stats.notFound++;
      console.log(`[${test.jiraKey}] not found in Xray; skipped`);
      continue;
    }

    if (!isManualTest(xrayTest)) {
      stats.skippedNonManual++;
      console.log(
        `[${test.jiraKey}] non-manual test (${xrayTest.testType?.kind}); skipped`
      );
      continue;
    }

    try {
      await processTest({
        openProjectId,
        testWorkPackage: test.workPackage,
        jiraKey: test.jiraKey,
        xrayTest,
        stepTypeId: stepType.id,
        verify,
        dryRun,
        prune,
        stats,
      });
    } catch (error) {
      stats.errors++;
      console.error(`[${test.jiraKey}] failed: ${error.message}`);
      if (error.response?.data) {
        console.error(
          "Error details:",
          JSON.stringify(error.response.data, null, 2)
        );
      }
    }
  }

  console.log("\n=== Test Step Migration Summary ===");
  console.log(`Tests checked: ${stats.tests}`);
  console.log(`Tests with Xray steps: ${stats.testsWithSteps}`);
  console.log(`Tests without Xray steps: ${stats.testsWithoutSteps}`);
  console.log(`Tests not found in Xray: ${stats.notFound}`);
  console.log(`Non-manual tests skipped: ${stats.skippedNonManual}`);
  console.log(`Xray steps: ${stats.expectedSteps}`);
  console.log(`OpenProject steps: ${stats.existingSteps}`);

  if (verify) {
    console.log(`Missing steps: ${stats.missing}`);
    console.log(`Extra steps: ${stats.extra}`);
    console.log(`Content mismatches: ${stats.mismatched}`);
    console.log(`Empty steps in Xray: ${stats.emptyXray}`);
    console.log(`Empty steps in OpenProject: ${stats.emptyOpenProject}`);
    console.log(`Errors: ${stats.errors}`);

    const failed =
      stats.missing > 0 ||
      stats.extra > 0 ||
      stats.mismatched > 0 ||
      stats.notFound > 0 ||
      stats.errors > 0;

    console.log(
      failed
        ? "\nVerification found differences."
        : "\nVerification passed: all Xray steps are present."
    );
    if (failed) process.exitCode = 1;
  } else {
    if (dryRun) {
      console.log(`Would create: ${stats.created}`);
      console.log(`Would update: ${stats.updated}`);
      console.log(`Would prune: ${stats.extra}`);
    } else {
      console.log(`Created: ${stats.created}`);
      console.log(`Updated: ${stats.updated}`);
      console.log(`Pruned: ${stats.pruned}`);
    }
    console.log(`Errors: ${stats.errors}`);
  }

  console.log("====================================\n");
  return stats;
}

function parseArgs(argv) {
  const options = {
    openProjectId: null,
    jiraProjectKey: null,
    issueKeys: null,
    typeNames: ["Test"],
    limit: null,
    verify: false,
    dryRun: false,
    prune: false,
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
    } else if (arg === "--types") {
      options.typeNames = argv[++i]
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean);
    } else if (arg === "--limit") {
      options.limit = parseInt(argv[++i], 10);
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
    "Usage: node migrate-test-steps.js OPENPROJECT_ID [--jira-project KEY] [--issues KEY1,KEY2] [--types Test] [--limit N] [--verify] [--dry-run] [--prune]"
  );
  console.log("");
  console.log("Examples:");
  console.log("  node migrate-test-steps.js 49 --jira-project PS --verify");
  console.log("  node migrate-test-steps.js 49 --jira-project PS --dry-run");
  console.log("  node migrate-test-steps.js 49 --jira-project PS");
}

if (require.main === module) {
  const options = parseArgs(process.argv.slice(2));

  if (!options.openProjectId) {
    printUsage();
    process.exit(1);
  }

  migrateTestSteps(options.openProjectId, options)
    .then(() => {
      if (process.exitCode === undefined) process.exitCode = 0;
    })
    .catch((error) => {
      console.error(`Test step migration failed: ${error.message}`);
      process.exitCode = 1;
    });
}

module.exports = { migrateTestSteps };
