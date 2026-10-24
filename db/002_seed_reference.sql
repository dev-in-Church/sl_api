-- Optional reference data for local development. Replace or remove before production.
INSERT INTO suppliers (supplier_code, full_name, phone)
VALUES ('SUP-1024', 'Amara Mutesi', '+256 772 410 201')
ON CONFLICT (supplier_code) DO NOTHING;
