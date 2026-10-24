import { Router } from "express";
import { me, register, signIn } from "../controllers/auth.controller.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();
router.post("/register", register);
router.post("/login", signIn);
router.get("/me", requireAuth, me);
export default router;
