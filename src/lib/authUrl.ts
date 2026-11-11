// Google flags the whole request as "unverified" if it merges in permissions an account granted
// to the project earlier (e.g. while testing Kairo HR). Ask only for what Kairo Link needs.
export function cleanAuthUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.hostname !== "accounts.google.com") return url;
    u.searchParams.delete("include_granted_scopes");
    const scope = u.searchParams.get("scope");
    if (scope) u.searchParams.set("scope", scope.split(" ").filter((s) => s && s !== "profile").join(" "));
    return u.toString();
  } catch {
    return url;
  }
}
