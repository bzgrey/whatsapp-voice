-- My own name for a contact from config.yaml `names:`; wins over WhatsApp's names.
ALTER TABLE contacts ADD COLUMN alias TEXT;
