import { deepStrictEqual as assertEquals } from "node:assert";
import { findJoinUrl } from "./providers.ts";

Deno.test("findJoinUrl picks video links from text", () => {
  assertEquals(findJoinUrl("Room 4", "Join: https://us02web.zoom.us/j/8123456789?pwd=abc."), "https://us02web.zoom.us/j/8123456789?pwd=abc");
  assertEquals(findJoinUrl("https://meet.google.com/abc-defg-hij"), "https://meet.google.com/abc-defg-hij");
  assertEquals(findJoinUrl("Click https://teams.microsoft.com/l/meetup-join/19%3ameeting_x/0?context=1 to join"), "https://teams.microsoft.com/l/meetup-join/19%3ameeting_x/0?context=1");
  assertEquals(findJoinUrl("Office, 2nd floor", null), null);
});
