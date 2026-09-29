/**
 * Restrooms and what a place has for children, as its record states them (OSM toilets*, highchair,
 * changing_table, kids_area). Which of them matter depends on who is going; that is engine policy.
 */
export const RESTROOM_AVAILABILITY = ["yes", "no"] as const;
export const RESTROOM_WHEELCHAIR = ["yes", "limited", "no"] as const;
export interface Restroom {
  /** "yes": visitors may use one (customers count: a visitor is one). "no": none, or not for visitors. */
  available?: (typeof RESTROOM_AVAILABILITY)[number];
  wheelchair?: (typeof RESTROOM_WHEELCHAIR)[number];
}

/** In the order a card or a details row names them. */
export const KID_FACILITIES = { highchair: "High chairs", changing_table: "Changing table", kids_area: "Kids' area" } as const;
export type KidFacility = keyof typeof KID_FACILITIES;
/**
 * As OSM defines each: high chairs are there or not; a changing table may be "limited" (somewhere to
 * change a diaper that isn't a purpose-built table), and so may a kids' area (OSM kids_area=limited).
 */
export interface KidFacilities {
  highchair?: "yes" | "no";
  changing_table?: "yes" | "limited" | "no";
  kids_area?: "yes" | "limited" | "no";
}
/** How much of a facility a place has, when it has any. */
export type KidFacilityLevel = "yes" | "limited";
