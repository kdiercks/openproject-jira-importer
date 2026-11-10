/*
 * Project Mapping (Optional)
 * ===========================
 *
 * Maps Jira project keys to OpenProject projects so list-catalog.js can
 * emit one combined row per Jira case type with its OpenProject case type.
 *
 * Value can be the OpenProject project ID (number) or identifier (string).
 *
 * Format:
 *   "JIRA_PROJECT_KEY": OPENPROJECT_ID_OR_IDENTIFIER,
 */

module.exports = {
  AIC: 8, // AIC - AIcebird
  BIONTWEB: 32, // BioNTech - Website (IVD)
  BMSRIT: 33, // BMS Run Info Tool
  BONEBANK: 34, // BONEBANK
  BONETAG: 35, // BoneTag
  BTRM: 36, // BONETAGRM
  BSFC: 37, // Bristol-Myers Squibb - Flow Cytometry Antibody System
  CDR100: 38, // CAMPTON Reader 100SW
  CDRRRM2: 39, // Campton Risk Management
  CLAIRE: 29, // Claire
  CBI: 18, // CBI - Cryotherm
  CBL: 40, // Cryotherm - BSC3 Lastenheft
  EMECK: 41, // EMECK
  INTAKT: 42, // INTAKT
  KIRA: 50, // Kira
  LOF: 43, // Lab OS Flux
  PEEXI: 44, // PE -Epson Expression 11000XL Integration
  PLGT: 45, // PerkinElmer - LabChip GX Touch
  PBMD: 46, // PerkinElmer - Berthold Mithras Driver
  PEEMP: 47, // PerkinElmer - Envision Enhancement and Maintenance Program
  PERSYSD: 48, // PerkinElmer - SystemDesigner
  PS: 49, // Process Software
  RM: 27, // RM - RISK MANAGEMENT
  RDGPS: 51, // RouteDocGPS
  SN: 52, // Sales Navigator
  BSA: 54, // AMS
  LABOS: 53, // Lab OS
  SBT2: 55, // soventec Business Tasks
  TSP: 58, // Testproject (check if this is the intended target)
  TES: 3, // Testporoject
  VSN: 56, // Vanadis - Smart NIPT
  VSNRISK: 57, // Vanadis Smart NIPT RISKS
};
