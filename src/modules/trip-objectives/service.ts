/**
 * src/modules/trip-objectives/service.ts
 *
 * Auto-CRUD over the four trip-objective models. No custom numbering — ids use
 * the model prefixes (trip_/tobjcat_/tobj_/tobs_).
 */

import { MedusaService } from "@medusajs/utils";

import { Trip } from "./models/trip";
import { TripObjectiveCategory } from "./models/trip-objective-category";
import { TripObjective } from "./models/trip-objective";
import { TripObjectiveObservation } from "./models/trip-objective-observation";

class TripObjectivesModuleService extends MedusaService({
  Trip,
  TripObjectiveCategory,
  TripObjective,
  TripObjectiveObservation,
}) {}

export default TripObjectivesModuleService;
