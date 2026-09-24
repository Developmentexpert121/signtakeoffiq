import { Router, type IRouter } from "express";
import authRouter from "./auth";
import dashboardRouter from "./dashboard";
import jobsRouter from "./jobs";
import filesRouter from "./files";
import sheetsRouter from "./sheets";
import roomsRouter from "./rooms";
import signsRouter from "./signs";
import exportsRouter from "./exports";
import trainingRouter from "./training";
import adminRouter from "./admin";
import usersRouter from "./users";
import invitationsRouter from "./invitations";
import storageRouter from "./storage";
import savedDateRangesRouter from "./savedDateRanges";
import pricingRouter from "./pricing";
import provisionUserRouter from "./provisionUser";

const router: IRouter = Router();

router.use(authRouter);
router.use(dashboardRouter);
router.use(jobsRouter);
router.use(filesRouter);
router.use(sheetsRouter);
router.use(roomsRouter);
router.use(signsRouter);
router.use(exportsRouter);
router.use(trainingRouter);
router.use(adminRouter);
router.use(usersRouter);
router.use(invitationsRouter);
router.use(storageRouter);
router.use(savedDateRangesRouter);
router.use(pricingRouter);
router.use(provisionUserRouter);

export default router;
