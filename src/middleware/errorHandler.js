export function errorHandler(error, req, res, next) {
  console.error("[SuperLeo API] request error:", error);
  if (error.code === "23505")
    return res
      .status(409)
      .json({ error: "A record with those details already exists" });
  res
    .status(error.statusCode || 500)
    .json({
      error: error.statusCode ? error.message : "Internal server error",
    });
}
