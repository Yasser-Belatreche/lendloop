import { convexTest } from "convex-test";
import { api } from "../convex/_generated/api";
import schema from "../convex/schema";

export const modules = import.meta.glob("../convex/**/*.ts");

export const SECRET = "test-secret-not-real";

export function setup() {
  process.env.LENDLOOP_WEBHOOK_SECRET = SECRET;
  process.env.N8N_REQUEST_WEBHOOK_URL = "https://n8n.example.test/webhook/lendloop-request";
  process.env.ADMIN_EMAILS = "admin@lendloop.test";
  return convexTest(schema, modules);
}

export type T = ReturnType<typeof setup>;

export async function signIn(t: T, name: string, email: string) {
  const as = t.withIdentity({ subject: email, name, givenName: name, email, emailVerified: true });
  const id = await as.mutation(api.users.store, {});
  return { as, id: id! };
}

export function plusDays(days: number) {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}
