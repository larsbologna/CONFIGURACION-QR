-- Esquema inicial del sistema de plásticos QR.

CREATE TABLE admins (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  last_login_at TEXT
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  admin_id INTEGER NOT NULL REFERENCES admins(id),
  csrf_token TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

-- Contadores monotónicos: nunca retroceden (numeración no reutilizable).
CREATE TABLE counters (
  name TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);
INSERT INTO counters(name, value) VALUES ('unit_serial', 0);

CREATE TABLE designs (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE design_versions (
  id INTEGER PRIMARY KEY,
  design_id INTEGER NOT NULL REFERENCES designs(id),
  version INTEGER NOT NULL,
  image_file TEXT NOT NULL,
  image_sha256 TEXT NOT NULL,
  image_original_name TEXT,
  image_width_px INTEGER NOT NULL,
  image_height_px INTEGER NOT NULL,
  image_format TEXT NOT NULL,
  width_mm REAL NOT NULL DEFAULT 100,
  height_mm REAL NOT NULL DEFAULT 150,
  config_json TEXT NOT NULL,
  notes TEXT,
  locked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  created_by INTEGER REFERENCES admins(id),
  UNIQUE (design_id, version)
);

-- Una versión usada por un lote queda congelada: así cada unidad se puede
-- re-exportar siempre idéntica.
CREATE TRIGGER design_versions_locked BEFORE UPDATE OF image_file, image_sha256, width_mm, height_mm, config_json ON design_versions
WHEN OLD.locked = 1
BEGIN
  SELECT RAISE(ABORT, 'La versión del diseño está bloqueada porque ya se usó en un lote');
END;
CREATE TRIGGER design_versions_no_delete BEFORE DELETE ON design_versions
WHEN OLD.locked = 1
BEGIN
  SELECT RAISE(ABORT, 'No se puede eliminar una versión usada en un lote');
END;

CREATE TABLE batches (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  design_version_id INTEGER NOT NULL REFERENCES design_versions(id),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  first_serial INTEGER NOT NULL,
  last_serial INTEGER NOT NULL,
  number_prefix TEXT NOT NULL DEFAULT '',
  number_min_digits INTEGER NOT NULL DEFAULT 3,
  placement_requested TEXT NOT NULL CHECK (placement_requested IN ('plancha', 'plastico', 'ambos')),
  number_on_sheet INTEGER NOT NULL,
  number_in_design INTEGER NOT NULL,
  warnings TEXT,
  base_url TEXT NOT NULL,
  notes TEXT,
  created_at TEXT NOT NULL,
  created_by INTEGER REFERENCES admins(id)
);
CREATE TRIGGER batches_no_delete BEFORE DELETE ON batches
BEGIN
  SELECT RAISE(ABORT, 'Los lotes no se pueden eliminar');
END;

CREATE TABLE businesses (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT,
  phone TEXT,
  contact TEXT,
  notes TEXT,
  delivery_date TEXT,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE units (
  id INTEGER PRIMARY KEY,
  serial INTEGER NOT NULL UNIQUE CHECK (serial > 0),
  display_number TEXT NOT NULL UNIQUE,
  public_id TEXT NOT NULL UNIQUE,
  qr_url TEXT NOT NULL UNIQUE,
  batch_id INTEGER NOT NULL REFERENCES batches(id),
  design_version_id INTEGER NOT NULL REFERENCES design_versions(id),
  status TEXT NOT NULL DEFAULT 'generado' CHECK (status IN
    ('generado', 'disponible', 'reservado', 'vendido', 'entregado', 'activo', 'pausado', 'defectuoso', 'baja')),
  destination_type TEXT,
  destination_url TEXT,
  destination_config TEXT,
  business_id INTEGER REFERENCES businesses(id),
  assigned_at TEXT,
  delivered_at TEXT,
  replaces_unit_id INTEGER REFERENCES units(id),
  scan_count INTEGER NOT NULL DEFAULT 0,
  last_scan_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_units_batch ON units(batch_id);
CREATE INDEX idx_units_business ON units(business_id);
CREATE INDEX idx_units_status ON units(status);

CREATE TRIGGER units_no_delete BEFORE DELETE ON units
BEGIN
  SELECT RAISE(ABORT, 'Las unidades no se pueden eliminar: usá el estado "baja"');
END;
CREATE TRIGGER units_immutable BEFORE UPDATE OF id, serial, display_number, public_id, qr_url, batch_id, design_version_id ON units
BEGIN
  SELECT RAISE(ABORT, 'El identificador, número y QR de una unidad son inmutables');
END;
CREATE TRIGGER units_baja_final BEFORE UPDATE OF status ON units
WHEN OLD.status = 'baja' AND NEW.status <> 'baja'
BEGIN
  SELECT RAISE(ABORT, 'Una unidad dada de baja no puede reactivarse');
END;

CREATE TABLE unit_history (
  id INTEGER PRIMARY KEY,
  unit_id INTEGER NOT NULL REFERENCES units(id),
  admin_id INTEGER REFERENCES admins(id),
  action TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  note TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_unit_history_unit ON unit_history(unit_id);
CREATE INDEX idx_unit_history_action ON unit_history(action, created_at);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY,
  admin_id INTEGER REFERENCES admins(id),
  username TEXT,
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id INTEGER,
  details TEXT,
  ip TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_audit_created ON audit_log(created_at);

-- Escaneos: sin IP, sin user-agent, sin datos personales.
CREATE TABLE scans (
  id INTEGER PRIMARY KEY,
  unit_id INTEGER NOT NULL REFERENCES units(id),
  business_id INTEGER,
  kind TEXT NOT NULL CHECK (kind IN ('escaneo', 'clic')),
  target TEXT,
  unit_status TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_scans_unit ON scans(unit_id, created_at);
CREATE INDEX idx_scans_created ON scans(created_at);
CREATE INDEX idx_scans_business ON scans(business_id, created_at);
