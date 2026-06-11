/*
 * Work Package Status Mapping
 * ============================
 *
 * Maps Jira status names to OpenProject work package status names.
 *
 * --- How to find status names ---
 *
 * Run `node migrate.js` and the tool will list all available statuses.
 * Or use the OpenProject API: GET /api/v3/statuses
 *
 * Format:
 *   "Jira Status Name": "OpenProject Status Name",
 *
 * If a Jira status is not listed here it defaults to "New".
 * If the mapped OpenProject status does not exist it falls back to
 * the first available status.
 */

module.exports = {
  "To Do": "New",
  "In Progress": "In progress",
  Done: "Closed",
  Closed: "Closed",
  Resolved: "Closed",
};
