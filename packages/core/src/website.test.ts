import { describe, expect, it } from "vitest";
import { websiteUrl } from "./website.js";

describe("websiteUrl: a site a user may be sent to", () => {
  it("takes a public http(s) site, adding the scheme OSM often leaves off", () => {
    expect(websiteUrl("angelikafilmcenter.com")).toBe("https://angelikafilmcenter.com/");
    expect(websiteUrl("  www.filmforum.org/now_playing ")).toBe("https://www.filmforum.org/now_playing");
    expect(websiteUrl("http://metrograph.com")).toBe("http://metrograph.com/");
    expect(websiteUrl("https://venue.example.com/?page=2")).toBe("https://venue.example.com/?page=2");
  });

  it("names none for free text, a blank, another scheme, or a local or IP host", () => {
    for (const bad of [null, undefined, "", "   ", "see our facebook", "call 212 555 0100", "javascript:alert(1)", "JavaScript:alert(1)", "data:text/html,hi", "ftp://cinema.example.com/", "mailto:box@cinema.example.com", "http://192.168.0.10/", "http://[::1]/", "https://localhost/", "http://cinema.local/", "https://intranet/", "http://0x7f000001/", "https://google.com@evil.example/", "https://user:pw@venue.example.com/", "https://:pw@venue.example.com/"]) {
      expect(websiteUrl(bad), String(bad)).toBeNull();
    }
  });
});
