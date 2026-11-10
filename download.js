require("dotenv").config();

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");
const { once } = require("events");
const axios = require("axios");
const { listProjects } = require("./jira-client");
const { authenticate, isXrayConfigured } = require("./xray-client");

const JIRA_HOST = (process.env.JIRA_HOST || "")
  .replace(/^https?:\/\//i, "")
  .replace(/\/+$/, "");
const JIRA_EMAIL = process.env.JIRA_EMAIL;
const JIRA_API_TOKEN = process.env.JIRA_API_TOKEN;
const JIRA_API_BASE = `https://${JIRA_HOST}/rest/api/3`;

const DEFAULT_XRAY_BASE_URL = "https://xray.cloud.getxray.app/api/v2";
const XRAY_BASE_URL = (
  process.env.XRAY_BASE_URL || DEFAULT_XRAY_BASE_URL
).replace(/\/+$/, "");

const EXPORT_DIR = path.resolve(process.env.EXPORT_DIR || "exports");
const TIMESTAMP = new Date().toISOString().replace(/[:.]/g, "-");
const OUTPUT_FILE = process.env.EXPORT_FILE
  ? path.resolve(process.env.EXPORT_FILE)
  : path.join(EXPORT_DIR, `jira-xray-export-${TIMESTAMP}.json.gz`);

const INCLUDE_ATTACHMENTS = parseBoolean(
  process.env.INCLUDE_ATTACHMENTS,
  true
);
const JIRA_CONCURRENCY = positiveInteger(
  process.env.JIRA_CONCURRENCY,
  4
);
const JIRA_PAGE_SIZE = positiveInteger(process.env.JIRA_PAGE_SIZE, 100);
const JIRA_SEARCH_PAGE_SIZE = positiveInteger(
  process.env.JIRA_SEARCH_PAGE_SIZE,
  100
);
const MAX_ATTACHMENT_BYTES = nonNegativeInteger(
  process.env.MAX_ATTACHMENT_BYTES,
  0
);
const REQUEST_RETRIES = nonNegativeInteger(process.env.REQUEST_RETRIES, 5);
const XRAY_BACKUP_POLL_MS = positiveInteger(
  process.env.XRAY_BACKUP_POLL_MS,
  10000
);
const XRAY_BACKUP_TIMEOUT_MS = positiveInteger(
  process.env.XRAY_BACKUP_TIMEOUT_MS,
  30 * 60 * 1000
);
const PROJECT_FILTER = (process.env.JIRA_PROJECTS || "")
  .split(",")
  .map((key) => key.trim())
  .filter(Boolean);

const jiraApi = axios.create({
  baseURL: JIRA_API_BASE,
  auth: {
    username: JIRA_EMAIL,
    password: JIRA_API_TOKEN,
  },
  timeout: 120000,
  headers: { Accept: "application/json" },
  maxBodyLength: Infinity,
});

const jiraDownloadApi = axios.create({
  baseURL: JIRA_API_BASE,
  auth: {
    username: JIRA_EMAIL,
    password: JIRA_API_TOKEN,
  },
  timeout: 300000,
  responseType: "arraybuffer",
  maxContentLength: Infinity,
  maxBodyLength: Infinity,
});

const xrayApi = axios.create({
  baseURL: XRAY_BASE_URL,
  timeout: 120000,
  maxContentLength: Infinity,
  maxBodyLength: Infinity,
});

const jiraLimiter = createLimiter(JIRA_CONCURRENCY);

function parseBoolean(value, defaultValue) {
  if (value === undefined || value === null || value === "") {
    return defaultValue;
  }
  return ["1", "true", "yes", "y", "on"].includes(
    String(value).toLowerCase()
  );
}

function positiveInteger(value, defaultValue) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

function nonNegativeInteger(value, defaultValue) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : defaultValue;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function errorMessage(error) {
  if (!error) return "Unknown error";
  if (error.response) {
    const status = error.response.status;
    const statusText = error.response.statusText || "";
    const data = error.response.data;
    let details = "";

    if (Buffer.isBuffer(data)) {
      details = data.toString("utf8").slice(0, 500);
    } else if (typeof data === "string") {
      details = data.slice(0, 500);
    } else if (data) {
      try {
        details = JSON.stringify(data).slice(0, 500);
      } catch (e) {
        details = String(data).slice(0, 500);
      }
    }

    return `${status} ${statusText} ${details}`.trim();
  }
  return error.message || String(error);
}

function createLimiter(limit) {
  let active = 0;
  const queue = [];

  function next() {
    if (active >= limit || queue.length === 0) return;
    active++;
    const job = queue.shift();

    Promise.resolve()
      .then(job.fn)
      .then(job.resolve, job.reject)
      .finally(() => {
        active--;
        next();
      });
  }

  return function run(fn) {
    return new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      next();
    });
  };
}

async function mapLimit(items, limit, mapper) {
  if (items.length === 0) return [];
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await mapper(items[index], index);
    }
  }

  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    () => worker()
  );
  await Promise.all(workers);
  return results;
}

async function requestWithRetry(label, fn) {
  let attempt = 0;

  while (true) {
    try {
      return await fn();
    } catch (error) {
      attempt++;
      const status = error.response?.status;
      const retryable =
        !status || status === 429 || (status >= 500 && status < 600);

      if (!retryable || attempt > REQUEST_RETRIES) {
        throw error;
      }

      let waitMs = Math.min(30000, 1000 * Math.pow(2, attempt - 1));
      const retryAfter = error.response?.headers?.["retry-after"];

      if (retryAfter) {
        const seconds = Number(retryAfter);
        if (Number.isFinite(seconds)) {
          waitMs = Math.max(0, seconds * 1000);
        } else {
          const date = Date.parse(retryAfter);
          if (!Number.isNaN(date)) {
            waitMs = Math.max(0, date - Date.now());
          }
        }
      }

      console.warn(
        `  ${label} failed (${status || error.code || error.message}); ` +
          `retrying in ${Math.ceil(waitMs / 1000)}s ` +
          `(attempt ${attempt}/${REQUEST_RETRIES})`
      );
      await delay(waitMs);
    }
  }
}

function jiraRequest(method, url, config = {}, label = null) {
  const requestLabel = label || `${method} ${url}`;
  return requestWithRetry(requestLabel, () =>
    jiraLimiter(() => jiraApi.request({ method, url, ...config }))
  );
}

function jiraGet(url, config = {}, label = null) {
  return jiraRequest("GET", url, config, label);
}

function jiraPost(url, data, config = {}, label = null) {
  return jiraRequest("POST", url, { ...config, data }, label);
}

function jiraDownload(url, config = {}, label = null) {
  const requestLabel = label || `GET ${url}`;
  return requestWithRetry(requestLabel, () =>
    jiraLimiter(() => jiraDownloadApi.get(url, config))
  );
}

async function fetchAllPages(url, params = {}, itemKey = null, label = null) {
  const items = [];
  let startAt = 0;

  while (true) {
    const response = await jiraGet(
      url,
      {
        params: {
          ...params,
          startAt,
          maxResults: JIRA_PAGE_SIZE,
        },
      },
      label
    );
    const data = response.data;
    let pageItems;

    if (Array.isArray(data)) {
      pageItems = data;
    } else if (itemKey && Array.isArray(data?.[itemKey])) {
      pageItems = data[itemKey];
    } else if (Array.isArray(data?.values)) {
      pageItems = data.values;
    } else {
      pageItems = [];
    }

    items.push(...pageItems);

    const total = typeof data?.total === "number" ? data.total : null;
    const isLast =
      Array.isArray(data) ||
      pageItems.length === 0 ||
      pageItems.length < JIRA_PAGE_SIZE ||
      (total !== null && items.length >= total);

    if (isLast) break;
    startAt += pageItems.length;
  }

  return items;
}

async function fetchIssuePropertyValues(issueKey) {
  const listResponse = await jiraGet(
    `/issue/${encodeURIComponent(issueKey)}/properties`,
    {},
    `GET properties ${issueKey}`
  );
  const keys = listResponse.data?.keys || [];
  const properties = {};

  for (const property of keys) {
    const propertyKey = property.key;
    if (!propertyKey) continue;

    try {
      const response = await jiraGet(
        `/issue/${encodeURIComponent(issueKey)}/properties/${encodeURIComponent(
          propertyKey
        )}`,
        {},
        `GET property ${issueKey}/${propertyKey}`
      );
      properties[propertyKey] = response.data?.value;
    } catch (error) {
      properties[propertyKey] = { error: errorMessage(error) };
    }
  }

  return properties;
}

function attachmentMetadata(attachment) {
  return {
    id: attachment.id,
    filename: attachment.filename,
    mimeType: attachment.mimeType,
    size: attachment.size,
    created: attachment.created,
    author: attachment.author,
    contentUrl: attachment.content,
    thumbnail: attachment.thumbnail,
  };
}

async function downloadJiraAttachment(attachment) {
  const metadata = attachmentMetadata(attachment);

  if (!INCLUDE_ATTACHMENTS) {
    return { ...metadata, contentOmitted: true };
  }

  if (MAX_ATTACHMENT_BYTES > 0 && attachment.size > MAX_ATTACHMENT_BYTES) {
    return {
      ...metadata,
      contentOmitted: true,
      reason: `Attachment exceeds MAX_ATTACHMENT_BYTES (${MAX_ATTACHMENT_BYTES})`,
    };
  }

  try {
    const response = await jiraDownload(
      attachment.content,
      {},
      `Download attachment ${attachment.id}`
    );
    const buffer = Buffer.from(response.data);
    return {
      ...metadata,
      size: buffer.length,
      contentType:
        response.headers?.["content-type"] || attachment.mimeType || null,
      sha256: sha256(buffer),
      contentBase64: buffer.toString("base64"),
    };
  } catch (error) {
    return { ...metadata, error: errorMessage(error) };
  }
}

async function enrichIssue(issue) {
  const issueKey = issue.key;
  const exported = {
    comments: [],
    changelog: [],
    watchers: null,
    votes: null,
    worklogs: [],
    remoteLinks: [],
    properties: {},
    attachments: [],
    errors: [],
  };

  const jobs = [
    ["comments", fetchAllPages(`/issue/${issueKey}/comment`, {}, "comments")],
    ["changelog", fetchAllPages(`/issue/${issueKey}/changelog`, {}, "histories")],
    ["worklogs", fetchAllPages(`/issue/${issueKey}/worklog`, {}, "worklogs")],
    ["watchers", jiraGet(`/issue/${issueKey}/watchers`).then((r) => r.data)],
    ["votes", jiraGet(`/issue/${issueKey}/votes`).then((r) => r.data)],
    ["remoteLinks", jiraGet(`/issue/${issueKey}/remotelink`).then((r) => r.data)],
    ["properties", fetchIssuePropertyValues(issueKey)],
  ];

  await Promise.all(
    jobs.map(async ([name, promise]) => {
      try {
        exported[name] = await promise;
      } catch (error) {
        exported.errors.push({ field: name, error: errorMessage(error) });
      }
    })
  );

  const attachments = issue.fields?.attachment || [];
  if (attachments.length > 0) {
    const attachmentConcurrency = Math.min(2, JIRA_CONCURRENCY);
    exported.attachments = await mapLimit(
      attachments,
      attachmentConcurrency,
      downloadJiraAttachment
    );
  }

  return { ...issue, export: exported };
}

async function fetchReferenceData() {
  const endpoints = [
    ["fields", "/field"],
    ["issueTypes", "/issuetype"],
    ["statuses", "/status"],
    ["priorities", "/priority"],
    ["resolutions", "/resolution"],
    ["statusCategories", "/statuscategory"],
    ["issueLinkTypes", "/issueLinkType"],
    ["projectTypes", "/project/type"],
    ["applicationRoles", "/applicationrole"],
  ];
  const result = {};

  for (const [name, url] of endpoints) {
    try {
      const response = await jiraGet(url, {}, `GET reference ${name}`);
      result[name] = response.data;
    } catch (error) {
      result[name] = { error: errorMessage(error) };
    }
  }

  return result;
}

async function fetchProjectBundle(project) {
  const key = project.key;
  const bundle = { summary: project };

  async function add(name, fn) {
    try {
      bundle[name] = await fn();
    } catch (error) {
      bundle[`${name}Error`] = errorMessage(error);
    }
  }

  await add("details", async () => {
    const response = await jiraGet(
      `/project/${encodeURIComponent(key)}`,
      {
        params: {
          expand: "description,lead,issueTypes,url,projectKeys",
        },
      },
      `GET project ${key}`
    );
    return response.data;
  });

  await add("versions", async () => {
    const response = await jiraGet(
      `/project/${encodeURIComponent(key)}/versions`,
      {},
      `GET versions ${key}`
    );
    return response.data;
  });

  await add("components", async () => {
    const response = await jiraGet(
      `/project/${encodeURIComponent(key)}/components`,
      {},
      `GET components ${key}`
    );
    return response.data;
  });

  await add("statuses", async () => {
    const response = await jiraGet(
      `/project/${encodeURIComponent(key)}/statuses`,
      {},
      `GET statuses ${key}`
    );
    return response.data;
  });

  await add("roles", async () => {
    const response = await jiraGet(
      `/project/${encodeURIComponent(key)}/role`,
      {},
      `GET roles ${key}`
    );
    const roles = response.data || {};
    const result = {};

    for (const [roleName, roleUrl] of Object.entries(roles)) {
      try {
        const roleResponse = await jiraGet(
          roleUrl,
          {},
          `GET role ${key}/${roleName}`
        );
        result[roleName] = roleResponse.data;
      } catch (error) {
        result[roleName] = { error: errorMessage(error) };
      }
    }

    return result;
  });

  return bundle;
}

async function fetchJiraIssuePage(projectKey, nextPageToken = null) {
  const body = {
    jql: `project = "${String(projectKey).replace(/"/g, '\\"')}" ORDER BY created ASC`,
    maxResults: JIRA_SEARCH_PAGE_SIZE,
    fields: ["*all"],
  };

  if (nextPageToken) {
    body.nextPageToken = nextPageToken;
  }

  const response = await jiraPost(
    "/search/jql",
    body,
    {},
    `Search issues ${projectKey}`
  );
  const data = response.data || {};

  return {
    issues: Array.isArray(data.issues) ? data.issues : [],
    isLast: data.isLast === true,
    nextPageToken: data.nextPageToken || null,
  };
}

class StreamingGzipJsonFile {
  constructor(filePath) {
    this.filePath = filePath;
    this.tempPath = `${filePath}.tmp-${process.pid}`;

    fs.mkdirSync(path.dirname(filePath), { recursive: true });

    this.gzip = zlib.createGzip({ level: zlib.constants.Z_BEST_COMPRESSION });
    this.file = fs.createWriteStream(this.tempPath);
    this.gzip.pipe(this.file);
    this.failure = null;

    this.gzip.on("error", (error) => {
      this.failure = error;
    });
    this.file.on("error", (error) => {
      this.failure = error;
    });
  }

  async write(chunk) {
    if (this.failure) throw this.failure;
    if (this.gzip.write(chunk)) return;
    await once(this.gzip, "drain");
  }

  async close() {
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        cleanup();
        reject(error);
      };
      const onFinish = () => {
        cleanup();
        resolve();
      };
      const cleanup = () => {
        this.file.off("finish", onFinish);
        this.file.off("error", onError);
        this.gzip.off("error", onError);
      };

      this.file.on("finish", onFinish);
      this.file.on("error", onError);
      this.gzip.on("error", onError);
      this.gzip.end();
    });

    fs.renameSync(this.tempPath, this.filePath);
  }

  abort() {
    try {
      this.gzip.destroy();
    } catch {}
    try {
      this.file.destroy();
    } catch {}
    try {
      fs.rmSync(this.tempPath, { force: true });
    } catch {}
  }
}

async function writeJson(writer, value) {
  await writer.write(JSON.stringify(value));
}

async function writeProject(writer, project) {
  const key = project.key;
  console.log(`\n[${key}] Downloading project metadata and issues...`);

  const bundle = await fetchProjectBundle(project);
  await writer.write('{"project":');
  await writeJson(writer, bundle);
  await writer.write(',"issues":[');

  let firstIssue = true;
  let issueCount = 0;
  let nextPageToken = null;

  do {
    const page = await fetchJiraIssuePage(key, nextPageToken);
    console.log(
      `[${key}] Fetched page with ${page.issues.length} issue(s), ` +
        `${issueCount + page.issues.length} total so far`
    );

    const enriched = await mapLimit(
      page.issues,
      Math.min(JIRA_CONCURRENCY, 4),
      enrichIssue
    );

    for (const issue of enriched) {
      if (!firstIssue) {
        await writer.write(",");
      }
      firstIssue = false;
      await writer.write(JSON.stringify(issue));
      issueCount++;
    }

    nextPageToken = page.isLast ? null : page.nextPageToken;
  } while (nextPageToken);

  await writer.write(`],"issueCount":${issueCount}}`);
  console.log(`[${key}] Done: ${issueCount} issue(s)`);
}

function isZipBuffer(buffer) {
  return (
    buffer.length >= 4 &&
    buffer[0] === 0x50 &&
    buffer[1] === 0x4b &&
    buffer[2] === 0x03 &&
    buffer[3] === 0x04
  );
}

function readZipEntries(buffer) {
  if (buffer.length < 22) {
    throw new Error("Invalid ZIP file: file is too small");
  }

  let eocdOffset = -1;
  const minOffset = Math.max(0, buffer.length - 22 - 0xffff);

  for (let offset = buffer.length - 22; offset >= minOffset; offset--) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) {
      eocdOffset = offset;
      break;
    }
  }

  if (eocdOffset === -1) {
    throw new Error("Invalid ZIP file: end of central directory not found");
  }

  const totalEntries = buffer.readUInt16LE(eocdOffset + 10);
  const centralDirectoryOffset = buffer.readUInt32LE(eocdOffset + 16);

  if (totalEntries === 0xffff || centralDirectoryOffset === 0xffffffff) {
    throw new Error("ZIP64 archives are not supported");
  }

  const entries = [];
  let offset = centralDirectoryOffset;

  for (let index = 0; index < totalEntries; index++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error("Invalid ZIP file: bad central directory entry");
    }

    const compressionMethod = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer
      .slice(offset + 46, offset + 46 + nameLength)
      .toString("utf8");

    if (
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      localHeaderOffset === 0xffffffff
    ) {
      throw new Error("ZIP64 entries are not supported");
    }

    if (!name.endsWith("/")) {
      if (buffer.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
        throw new Error(`Invalid ZIP file: bad local header for ${name}`);
      }

      const localNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
      const localExtraLength = buffer.readUInt16LE(localHeaderOffset + 28);
      const dataOffset =
        localHeaderOffset + 30 + localNameLength + localExtraLength;
      const compressed = buffer.slice(dataOffset, dataOffset + compressedSize);
      let data;

      if (compressionMethod === 0) {
        data = compressed;
      } else if (compressionMethod === 8) {
        data = zlib.inflateRawSync(compressed);
      } else {
        throw new Error(
          `Unsupported ZIP compression method ${compressionMethod} for ${name}`
        );
      }

      entries.push({ name, data });
    }

    offset += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

function xrayRequest(method, url, token, config = {}) {
  return requestWithRetry(`Xray ${method} ${url}`, () =>
    xrayApi.request({
      method,
      url,
      ...config,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(config.headers || {}),
      },
    })
  );
}

async function createXrayBackupJob(token) {
  const payload = {
    withAttachment: INCLUDE_ATTACHMENTS,
    excludeIssueHistory: false,
    excludeArchivedTestRuns: false,
  };

  try {
    const response = await xrayRequest("POST", "/backup", token, {
      data: payload,
      headers: { "Content-Type": "application/json" },
    });
    const data = response.data;
    const jobId =
      typeof data === "string"
        ? data
        : data?.jobId || data?.id || data?.jobID || null;

    if (jobId) {
      console.log(`Xray backup job created: ${jobId}`);
    }

    return { jobId, reuseExisting: false };
  } catch (error) {
    if (error.response?.status === 400) {
      console.warn(
        "Xray did not create a new backup job (another backup may already " +
          "exist). Trying to download the most recent backup file."
      );
      return { jobId: null, reuseExisting: true };
    }
    throw error;
  }
}

async function waitForXrayBackup(token, jobId) {
  const startedAt = Date.now();
  let lastProgress = null;

  while (Date.now() - startedAt < XRAY_BACKUP_TIMEOUT_MS) {
    const response = await xrayRequest(
      "GET",
      `/backup/${encodeURIComponent(jobId)}/status`,
      token
    );
    const status = String(response.data?.status || "").toLowerCase();
    const progress = response.data?.progressValue || null;

    if (progress && progress !== lastProgress) {
      console.log(`Xray backup progress: ${progress}`);
      lastProgress = progress;
    }

    if (status === "successful" || status === "success") {
      console.log("Xray backup completed.");
      return response.data;
    }

    if (["failed", "error", "cancelled", "canceled"].includes(status)) {
      throw new Error(`Xray backup failed with status "${status}"`);
    }

    await delay(XRAY_BACKUP_POLL_MS);
  }

  throw new Error(
    `Xray backup timed out after ${Math.round(
      XRAY_BACKUP_TIMEOUT_MS / 1000
    )} seconds`
  );
}

async function downloadXrayFile(token, url) {
  const response = await xrayRequest("GET", url, token, {
    responseType: "arraybuffer",
    timeout: 600000,
  });
  return Buffer.from(response.data);
}

async function fetchXrayBackup() {
  const token = await authenticate();
  const job = await createXrayBackupJob(token);

  if (job.jobId) {
    await waitForXrayBackup(token, job.jobId);
  }

  console.log("Downloading Xray backup file...");
  const backup = await downloadXrayFile(token, "/backup/file");
  let attachmentArchive = null;
  let attachmentArchiveError = null;

  if (INCLUDE_ATTACHMENTS) {
    console.log("Downloading Xray attachment backup file...");
    try {
      attachmentArchive = await downloadXrayFile(
        token,
        "/backup/file/attachment"
      );
    } catch (error) {
      attachmentArchiveError = errorMessage(error);
      console.warn(
        `Could not download Xray attachment backup: ${attachmentArchiveError}`
      );
    }
  }

  return {
    jobId: job.jobId,
    backup,
    attachmentArchive,
    attachmentArchiveError,
  };
}

async function writeXraySection(writer) {
  if (!isXrayConfigured()) {
    await writeJson(writer, {
      enabled: false,
      reason:
        "XRAY_CLIENT_ID and XRAY_CLIENT_SECRET are not configured in .env",
    });
    return;
  }

  console.log("\n[Xray] Downloading Xray backup...");

  let result;
  try {
    result = await fetchXrayBackup();
  } catch (error) {
    console.warn(`Xray export failed: ${errorMessage(error)}`);
    await writeJson(writer, {
      enabled: true,
      error: errorMessage(error),
    });
    return;
  }

  const { backup, attachmentArchive, attachmentArchiveError } = result;
  await writer.write('{"enabled":true,"mode":"backup"');
  await writer.write(`,"jobId":${JSON.stringify(result.jobId || null)}`);
  await writer.write(
    `,"backupFile":${JSON.stringify({
      size: backup.length,
      sha256: sha256(backup),
    })}`
  );

  if (isZipBuffer(backup)) {
    const entries = readZipEntries(backup);
    const jsonEntries = entries.filter((entry) =>
      entry.name.toLowerCase().endsWith(".json")
    );
    const otherEntries = entries.filter(
      (entry) => !entry.name.toLowerCase().endsWith(".json")
    );

    await writer.write(',"files":{');
    const usedNames = new Set();
    const unparsedEntries = [];
    let wroteFile = false;

    for (const entry of jsonEntries) {
      const text = entry.data.toString("utf8").replace(/^\uFEFF/, "");

      try {
        JSON.parse(text);
      } catch (error) {
        unparsedEntries.push(entry);
        continue;
      }

      let name = entry.name;
      let suffix = 1;
      while (usedNames.has(name)) {
        name = `${entry.name}.${suffix++}`;
      }
      usedNames.add(name);

      if (wroteFile) {
        await writer.write(",");
      }
      wroteFile = true;
      await writer.write(`${JSON.stringify(name)}:${text}`);
    }

    await writer.write('}');

    const remainingEntries = [...otherEntries, ...unparsedEntries];

    if (remainingEntries.length > 0) {
      await writer.write(',"otherFiles":[');
      let first = true;

      for (const entry of remainingEntries) {
        if (!first) await writer.write(",");
        first = false;
        await writer.write(
          JSON.stringify({
            name: entry.name,
            size: entry.data.length,
            sha256: sha256(entry.data),
            ...(INCLUDE_ATTACHMENTS
              ? { contentBase64: entry.data.toString("base64") }
              : { contentOmitted: true }),
          })
        );
      }

      await writer.write("]");
    }
  } else {
    const text = backup.toString("utf8").replace(/^\uFEFF/, "");
    let isJson = false;

    try {
      JSON.parse(text);
      isJson = true;
    } catch (error) {
      isJson = false;
    }

    if (isJson) {
      await writer.write(`,"files":{"backup.json":${text}}`);
    } else {
      await writer.write(
        `,"backupFileBase64":${JSON.stringify(backup.toString("base64"))}`
      );
    }
  }

  if (attachmentArchive) {
    await writer.write(
      `,"attachmentArchive":${JSON.stringify({
        size: attachmentArchive.length,
        sha256: sha256(attachmentArchive),
        contentBase64: attachmentArchive.toString("base64"),
      })}`
    );
  } else if (attachmentArchiveError) {
    await writer.write(
      `,"attachmentArchiveError":${JSON.stringify(attachmentArchiveError)}`
    );
  }

  await writer.write("}");
  console.log("[Xray] Done");
}

async function main() {
  if (!JIRA_HOST || !JIRA_EMAIL || !JIRA_API_TOKEN) {
    throw new Error(
      "JIRA_HOST, JIRA_EMAIL and JIRA_API_TOKEN must be set in .env"
    );
  }

  console.log("Jira/Xray export");
  console.log(`  Jira host: ${JIRA_HOST}`);
  console.log(`  Output file: ${OUTPUT_FILE}`);
  console.log(
    `  Attachments: ${INCLUDE_ATTACHMENTS ? "included" : "metadata only"}`
  );

  const startedAt = new Date().toISOString();
  const writer = new StreamingGzipJsonFile(OUTPUT_FILE);

  try {
    await writer.write('{"metadata":');
    await writeJson(writer, {
      generatedAt: startedAt,
      jiraHost: JIRA_HOST,
      jiraApiBase: JIRA_API_BASE,
      xrayBaseUrl: XRAY_BASE_URL,
      outputFile: OUTPUT_FILE,
      options: {
        includeAttachments: INCLUDE_ATTACHMENTS,
        maxAttachmentBytes: MAX_ATTACHMENT_BYTES || null,
        projectFilter: PROJECT_FILTER,
        jiraConcurrency: JIRA_CONCURRENCY,
        jiraPageSize: JIRA_PAGE_SIZE,
        jiraSearchPageSize: JIRA_SEARCH_PAGE_SIZE,
        requestRetries: REQUEST_RETRIES,
      },
    });

    console.log("\nDownloading global Jira reference data...");
    await writer.write(',"referenceData":');
    await writeJson(writer, await fetchReferenceData());

    let projects = await listProjects();
    if (PROJECT_FILTER.length > 0) {
      projects = projects.filter((project) =>
        PROJECT_FILTER.includes(project.key)
      );
    }

    if (projects.length === 0) {
      throw new Error("No Jira projects matched the configured filter");
    }

    await writer.write(',"projects":[');

    for (let index = 0; index < projects.length; index++) {
      if (index > 0) await writer.write(",");
      await writeProject(writer, projects[index]);
    }

    await writer.write("]");
    await writer.write(',"xray":');
    await writeXraySection(writer);
    await writer.write("}");

    await writer.close();

    const size = fs.statSync(OUTPUT_FILE).size;
    console.log(
      `\nExport complete: ${OUTPUT_FILE} (${(size / 1024 / 1024).toFixed(2)} MiB)`
    );
  } catch (error) {
    writer.abort();
    throw error;
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`\nExport failed: ${errorMessage(error)}`);
    process.exitCode = 1;
  });
}

module.exports = {
  readZipEntries,
  isZipBuffer,
};
