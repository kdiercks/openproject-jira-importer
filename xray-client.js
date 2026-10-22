require("dotenv").config();
const axios = require("axios");

const DEFAULT_BASE_URL = "https://xray.cloud.getxray.app/api/v2";

const xrayBaseUrl = (process.env.XRAY_BASE_URL || DEFAULT_BASE_URL).replace(
  /\/$/,
  ""
);
const xrayClientId = process.env.XRAY_CLIENT_ID;
const xrayClientSecret = process.env.XRAY_CLIENT_SECRET;

let accessToken = null;
let accessTokenExpiresAt = 0;

function isXrayConfigured() {
  return Boolean(xrayClientId && xrayClientSecret);
}

async function authenticate(force = false) {
  if (!isXrayConfigured()) {
    throw new Error(
      "XRAY_CLIENT_ID and XRAY_CLIENT_SECRET must be set in .env to use Xray integration"
    );
  }

  if (!force && accessToken && Date.now() < accessTokenExpiresAt) {
    return accessToken;
  }

  const response = await axios.post(
    `${xrayBaseUrl}/authenticate`,
    {
      client_id: xrayClientId,
      client_secret: xrayClientSecret,
    },
    {
      headers: { "Content-Type": "application/json" },
      timeout: 30000,
    }
  );

  let token =
    typeof response.data === "string"
      ? response.data
      : response.data?.token || response.data?.access_token;

  if (typeof token === "string") {
    token = token.trim().replace(/^"|"$/g, "");
  }

  if (!token) {
    throw new Error("Xray authentication did not return an access token");
  }

  accessToken = token;
  accessTokenExpiresAt = Date.now() + 23 * 60 * 60 * 1000;
  return accessToken;
}

async function graphql(query, variables = {}, retry = true) {
  const token = await authenticate();

  try {
    const response = await axios.post(
      `${xrayBaseUrl}/graphql`,
      { query, variables },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        timeout: 60000,
      }
    );

    if (response.data?.errors?.length) {
      const messages = response.data.errors
        .map((error) => error.message)
        .join("; ");
      throw new Error(`Xray GraphQL error: ${messages}`);
    }

    return response.data?.data || {};
  } catch (error) {
    if (retry && error.response?.status === 401) {
      accessToken = null;
      accessTokenExpiresAt = 0;
      await authenticate(true);
      return graphql(query, variables, false);
    }
    throw error;
  }
}

const GET_TESTS_QUERY = `
  query GetTests($jql: String!, $limit: Int!, $start: Int) {
    getTests(jql: $jql, limit: $limit, start: $start) {
      total
      start
      limit
      results {
        issueId
        testType {
          name
          kind
        }
        jira(fields: ["key"])
        steps {
          id
          action
          data
          result
        }
      }
    }
  }
`;

const GET_TEST_EXECUTIONS_QUERY = `
  query GetTestExecutions($jql: String!, $limit: Int!, $start: Int) {
    getTestExecutions(jql: $jql, limit: $limit, start: $start) {
      total
      start
      limit
      results {
        issueId
        lastModified
        jira(fields: ["key", "summary"])
      }
    }
  }
`;

const GET_TEST_EXECUTION_ASSOCIATIONS_QUERY = `
  query GetTestExecutionAssociations(
    $issueId: String!
    $limit: Int!
    $testStart: Int!
    $planStart: Int!
  ) {
    getTestExecution(issueId: $issueId) {
      issueId
      tests(limit: $limit, start: $testStart) {
        total
        start
        limit
        results {
          issueId
          jira(fields: ["key"])
        }
      }
      testPlans(limit: $limit, start: $planStart) {
        total
        start
        limit
        results {
          issueId
          jira(fields: ["key"])
        }
      }
    }
  }
`;

async function getTestsByJql(jql, pageSize = 100) {
  const tests = [];
  let start = 0;

  while (true) {
    const data = await graphql(GET_TESTS_QUERY, { jql, limit: pageSize, start });
    const page = data.getTests;

    if (!page || !Array.isArray(page.results) || page.results.length === 0) {
      break;
    }

    tests.push(...page.results);

    if (tests.length >= page.total) {
      break;
    }

    start += page.results.length;
  }

  return tests;
}

async function getTestExecutionsByJql(jql, pageSize = 100) {
  const executions = [];
  let start = 0;

  while (true) {
    const data = await graphql(GET_TEST_EXECUTIONS_QUERY, {
      jql,
      limit: pageSize,
      start,
    });
    const page = data.getTestExecutions;

    if (!page || !Array.isArray(page.results) || page.results.length === 0) {
      break;
    }

    executions.push(...page.results);

    if (executions.length >= page.total) {
      break;
    }

    start += page.results.length;
  }

  return executions;
}

async function getExecutionAssociationKeys(executionIssueId, pageSize = 100) {
  const testKeys = [];
  const planKeys = [];
  let testStart = 0;
  let planStart = 0;
  let testsDone = false;
  let plansDone = false;

  while (!testsDone || !plansDone) {
    const data = await graphql(GET_TEST_EXECUTION_ASSOCIATIONS_QUERY, {
      issueId: executionIssueId,
      limit: pageSize,
      testStart,
      planStart,
    });
    const execution = data.getTestExecution;

    if (!execution) {
      throw new Error(
        `Xray test execution ${executionIssueId} could not be loaded`
      );
    }

    if (!testsDone) {
      const page = execution.tests;
      const results = page?.results || [];
      testKeys.push(
        ...results.map((test) => extractJiraKey(test.jira)).filter(Boolean)
      );
      testStart += results.length;
      testsDone =
        results.length === 0 ||
        results.length < pageSize ||
        testStart >= (page?.total || 0);
    }

    if (!plansDone) {
      const page = execution.testPlans;
      const results = page?.results || [];
      planKeys.push(
        ...results.map((plan) => extractJiraKey(plan.jira)).filter(Boolean)
      );
      planStart += results.length;
      plansDone =
        results.length === 0 ||
        results.length < pageSize ||
        planStart >= (page?.total || 0);
    }
  }

  return {
    testKeys: [...new Set(testKeys)],
    planKeys: [...new Set(planKeys)],
  };
}

function extractJiraKey(jiraValue) {
  if (!jiraValue) return null;
  if (typeof jiraValue === "string") return jiraValue;
  if (Array.isArray(jiraValue)) {
    for (const item of jiraValue) {
      const key = extractJiraKey(item);
      if (key) return key;
    }
    return null;
  }
  if (typeof jiraValue === "object") {
    return (
      jiraValue.key ||
      jiraValue.Key ||
      jiraValue.fields?.key ||
      jiraValue.fields?.Key ||
      null
    );
  }
  return null;
}

async function getTestsByKeys(issueKeys, chunkSize = 50) {
  const result = new Map();
  const keys = [...new Set(issueKeys.filter(Boolean))];

  for (let i = 0; i < keys.length; i += chunkSize) {
    const chunk = keys.slice(i, i + chunkSize);
    const jql = `key in (${chunk
      .map((key) => `"${String(key).replace(/"/g, '\\"')}"`)
      .join(", ")})`;

    const tests = await getTestsByJql(jql);
    for (const test of tests) {
      const key = extractJiraKey(test.jira);
      if (key) {
        result.set(key, test);
      }
    }
  }

  return result;
}

async function getTestExecutionsByKeys(issueKeys, chunkSize = 50) {
  const result = new Map();
  const keys = [...new Set(issueKeys.filter(Boolean))];

  for (let i = 0; i < keys.length; i += chunkSize) {
    const chunk = keys.slice(i, i + chunkSize);
    const jql = `key in (${chunk
      .map((key) => `"${String(key).replace(/"/g, '\\"')}"`)
      .join(", ")})`;

    const executions = await getTestExecutionsByJql(jql);
    for (const execution of executions) {
      const key = extractJiraKey(execution.jira);
      if (!key) continue;

      const associations = await getExecutionAssociationKeys(
        execution.issueId
      );
      result.set(key, {
        ...execution,
        ...associations,
      });
    }
  }

  return result;
}

module.exports = {
  isXrayConfigured,
  authenticate,
  getTestsByJql,
  getTestsByKeys,
  getTestExecutionsByJql,
  getTestExecutionsByKeys,
  extractJiraKey,
};
