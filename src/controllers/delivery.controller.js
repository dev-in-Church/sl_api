export async function listDeliveries(req, res) { res.json({ supplierId: req.user.id, deliveries: [] }) }
export async function createDelivery(req, res) { res.status(201).json({ message: 'Persist delivery through your repository layer', delivery: req.body }) }
