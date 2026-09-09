import { z } from "zod";
import { getBusinessDateString } from "../date/et";

/** Validate a civil bank date; UTC is used only to reject invalid calendar dates. */
export const reviewDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const year = Number(value.slice(0, 4)), month = Number(value.slice(5, 7)), day = Number(value.slice(8, 10));
  if (year < 1900 || year > 2200) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}, "Invalid calendar date");

export const reviewToday = () => getBusinessDateString(new Date());
export const openingAmount = z.string().trim().regex(/^-?(?:0|[1-9]\d{0,14})(?:\.\d{1,8})?$/);
