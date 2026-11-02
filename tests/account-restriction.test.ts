import { test } from "node:test";
import assert from "node:assert/strict";
import {
  RESTRICTED_PATH,
  RESTRICTION_STATUS_API_PATH,
  restrictionDecision,
  restrictionUnavailableDecision,
} from "../src/lib/account-restriction";

test("restricted accounts cannot use protected API routes", () => {
  assert.equal(restrictionDecision("/api/vcaas/projects", true), "deny_api");
  assert.equal(restrictionDecision("/api/runtime/project-1", true), "deny_api");
});

test("only the exact status endpoint is reachable while restricted", () => {
  assert.equal(restrictionDecision(RESTRICTION_STATUS_API_PATH, true), "allow");
  assert.equal(restrictionDecision(`${RESTRICTION_STATUS_API_PATH}/other`, true), "deny_api");
});

test("restricted pages go to the account suspension screen", () => {
  assert.equal(restrictionDecision("/dashboard", true), "redirect_page");
  assert.equal(restrictionDecision("/project/project-1", true), "redirect_page");
  assert.equal(restrictionDecision(RESTRICTED_PATH, true), "allow");
});

test("a failed restriction check fails closed for protected routes", () => {
  assert.equal(restrictionUnavailableDecision("/api/vcaas/projects"), "unavailable_api");
  assert.equal(restrictionUnavailableDecision("/dashboard"), "unavailable_page");
});

test("support, sign-out, login and suspension remain reachable when status is unavailable", () => {
  for (const pathname of [
    RESTRICTED_PATH,
    "/support",
    "/login",
    "/auth/signout",
    RESTRICTION_STATUS_API_PATH,
  ]) {
    assert.equal(restrictionUnavailableDecision(pathname), "allow", pathname);
  }
});
