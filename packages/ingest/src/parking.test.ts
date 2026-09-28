import { describe, expect, it } from "vitest";
import { parkingFromTags } from "./parking.js";

describe("parking from OSM tags", () => {
  it("a lot, a garage, street spaces: named or not, with what the tags say about paying", () => {
    expect(parkingFromTags({ amenity: "parking" })).toEqual({ name: null, kind: "lot", fee: "unknown", capacity: null, openingHours: null });
    expect(parkingFromTags({ amenity: "parking", parking: "multi-storey", name: " Rivington Garage ", fee: "yes", capacity: "240", opening_hours: "24/7" })).toEqual({ name: "Rivington Garage", kind: "garage", fee: "paid", capacity: 240, openingHours: "24/7" });
    expect(parkingFromTags({ amenity: "parking", parking: "underground", fee: "no" })).toMatchObject({ kind: "garage", fee: "free" });
    expect(parkingFromTags({ amenity: "parking", parking: "street_side" })).toMatchObject({ kind: "street" });
  });

  it("a charge only at some times is unknown: check the signs", () => {
    expect(parkingFromTags({ amenity: "parking", fee: "yes", "fee:conditional": "no @ (Su)" })?.fee).toBe("unknown");
    expect(parkingFromTags({ amenity: "parking", fee: "no", "fee:conditional": "yes @ (Mo-Fr 08:00-18:00)" })?.fee).toBe("unknown");
  });

  it("only places anyone may park: no private, customer-only, permit or resident lots, no carports or garage boxes", () => {
    for (const access of ["private", "customers", "permit", "residents", "no", "delivery"]) expect(parkingFromTags({ amenity: "parking", access })).toBeNull();
    for (const access of ["yes", "public", "permissive", "destination"]) expect(parkingFromTags({ amenity: "parking", access })).not.toBeNull();
    for (const parking of ["carports", "garage_boxes", "sheds", "something_new"]) expect(parkingFromTags({ amenity: "parking", parking })).toBeNull();
    expect(parkingFromTags({ amenity: "restaurant", name: "Not parking" })).toBeNull();
  });

  it("the most specific access tag for a car decides, either way", () => {
    // Restricted for cars even though the lot is open in general, or unrestricted at a general level.
    expect(parkingFromTags({ amenity: "parking", motor_vehicle: "private" })).toBeNull();
    expect(parkingFromTags({ amenity: "parking", motorcar: "customers" })).toBeNull();
    expect(parkingFromTags({ amenity: "parking", access: "yes", vehicle: "no" })).toBeNull();
    expect(parkingFromTags({ amenity: "parking", access: "yes", motor_vehicle: "permit", motorcar: "residents" })).toBeNull();
    // Open to cars even though access in general is restricted.
    expect(parkingFromTags({ amenity: "parking", access: "private", motorcar: "yes" })).not.toBeNull();
    expect(parkingFromTags({ amenity: "parking", access: "no", motor_vehicle: "designated" })).not.toBeNull();
    expect(parkingFromTags({ amenity: "parking", vehicle: "private", motorcar: "yes" })).not.toBeNull();
    // Restricted only at some times is not plainly open.
    expect(parkingFromTags({ amenity: "parking", "access:conditional": "no @ (Mo-Fr 07:00-19:00)" })).toBeNull();
    expect(parkingFromTags({ amenity: "parking", access: "yes", "motorcar:conditional": "customers @ (Sa,Su)" })).toBeNull();
  });

  it("a capacity that isn't a count is dropped", () => {
    expect(parkingFromTags({ amenity: "parking", capacity: "about 50" })?.capacity).toBeNull();
    expect(parkingFromTags({ amenity: "parking", capacity: "0" })?.capacity).toBeNull();
  });
});
