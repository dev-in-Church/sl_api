import { Router } from "express";
import { requireAuth, requireRoles } from "../middleware/auth.js";
import { report, pdf, email } from "../controllers/report.controller.js";
const router = Router();
router.use(requireAuth, requireRoles("manager", "admin"));
router.get("/", report);
router.get("/pdf", pdf);
router.post("/email", email);
export default router;
