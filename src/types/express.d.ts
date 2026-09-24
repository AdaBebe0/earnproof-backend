import { AuthenticatedSession } from "../auth/auth.types";

declare module "express-serve-static-core" {
  interface Request {
    user?: AuthenticatedSession;
  }
}
