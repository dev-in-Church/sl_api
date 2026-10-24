import { Router } from 'express'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { listDeliveries, createDelivery } from '../controllers/delivery.controller.js'
const router = Router()
router.use(requireAuth)
router.get('/', listDeliveries)
router.post('/', requireRole('manager'), createDelivery)
export default router
