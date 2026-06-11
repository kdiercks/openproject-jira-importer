/*
 * Work Package Type Mapping (Optional Overrides)
 * ===============================================
 *
 * Maps Jira issue type names to OpenProject work package type names.
 * Only needed when the names differ between Jira and OpenProject.
 * Types with the same name in both systems are auto-matched.
 *
 * --- How to find type names ---
 *
 * Run `node migrate.js` and the tool will list all available types.
 * Or use the OpenProject API: GET /api/v3/types
 *
 * Format:
 *   "Jira Issue Type Name": "OpenProject Type Name",
 *
 * If a Jira type has no override and no matching OpenProject type
 * it defaults to "Task".
 */

module.exports = {
  Story: "User story",
  Requirement: "Requirement",
};
