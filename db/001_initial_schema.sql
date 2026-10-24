-- SuperLeo Dairy Management initial schema
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS suppliers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_code VARCHAR(32) UNIQUE NOT NULL,
  full_name VARCHAR(160) NOT NULL,
  phone VARCHAR(40),
  email VARCHAR(255) UNIQUE,
  password_hash TEXT,
  address TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS collection_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_date DATE NOT NULL,
  session_type VARCHAR(16) NOT NULL CHECK (session_type IN ('morning', 'evening')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (session_date, session_type)
);

CREATE TABLE IF NOT EXISTS milk_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id UUID NOT NULL REFERENCES suppliers(id),
  session_id UUID NOT NULL REFERENCES collection_sessions(id),
  quantity_litres NUMERIC(10,2) NOT NULL CHECK (quantity_litres > 0),
  recorded_by VARCHAR(160),
  verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (supplier_id, session_id)
);

CREATE INDEX IF NOT EXISTS idx_deliveries_supplier ON milk_deliveries(supplier_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_date ON collection_sessions(session_date DESC);
