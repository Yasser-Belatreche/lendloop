import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

// Next.js 16 "proxy" (formerly middleware). /app requires a session; the real
// authorization happens again in every Convex function.
const isProtected = createRouteMatcher(["/app(.*)"]);

export default clerkMiddleware(async (auth, req) => {
  if (isProtected(req)) await auth.protect();
});

export const config = {
  matcher: ["/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)", "/(api|trpc)(.*)"],
};
