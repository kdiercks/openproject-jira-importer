/*
 * Work Package Priority Mapping
 * ==============================
 *
 * Maps Jira priority names to OpenProject work package priority names.
 *
 * --- How to find priority names ---
 *
 * Run `node migrate.js` and the tool will list all available priorities.
 * Or use the OpenProject API: GET /api/v3/priorities
 *
 * Format:
 *   "Jira Priority Name": "OpenProject Priority Name",
 *
 * If a Jira priority is not listed here it defaults to "Normal".
 * If the mapped OpenProject priority does not exist it falls back to
 * the default priority for the project.
 */

module.exports = {
  Highest: "Immediate",
  High: "High",
  Medium: "Normal",
  Low: "Low",
  Lowest: "Low",
};
