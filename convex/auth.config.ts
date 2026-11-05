// Convex validates Clerk-issued JWTs (Clerk "Convex" integration / JWT template "convex").
export default {
  providers: [
    {
      domain: process.env.CLERK_JWT_ISSUER_DOMAIN!,
      applicationID: "convex",
    },
  ],
};
