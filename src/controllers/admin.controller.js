export async function dashboard(_req, res) { res.json({ registeredSuppliers: 0, morningLitres: 0, eveningLitres: 0 }) }
export async function listSuppliers(_req, res) { res.json({ suppliers: [] }) }
export async function createSupplier(req, res) { res.status(201).json({ message: 'Persist supplier through your repository layer', supplier: req.body }) }
