/**
 * Canonical warehouse location IDs.
 * Fallbacks are the real IDs from the production database.
 */
export const USA_LOC =
  process.env.ECOPOWERTECH_MIAMI_LOCATION_ID ?? "sloc_01KFS2AV3TAKR141KC2D6JCGTR";

export const CHINA_LOC =
  process.env.CHINA_WAREHOUSE_LOCATION_ID ?? "sloc_01KQ14C1CFX30EDD722BF87HDM";
