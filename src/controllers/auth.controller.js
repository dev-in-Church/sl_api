import { login, registerSupplier } from "../services/auth.service.js";

export async function register(req, res, next) {
  try {
    res.status(201).json({ data: await registerSupplier(req.body) });
  } catch (error) {
    next(error);
  }
}
export async function signIn(req, res, next) {
  try {
    res.json({ data: await login(req.body) });
  } catch (error) {
    next(error);
  }
}
export async function me(req, res) {
  res.json({ data: req.user });
}
