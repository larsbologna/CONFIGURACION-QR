-- Etiqueta libre por unidad (ej. nombre del negocio) y revisión del registro publicado.
ALTER TABLE units ADD COLUMN label TEXT;
INSERT OR IGNORE INTO counters(name, value) VALUES ('registry_revision', 0);
