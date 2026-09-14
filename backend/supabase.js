const { createClient } = require("@supabase/supabase-js");

const url = process.env.SUPABASE_URL?.trim();
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();

function isSupabaseConfigured() {
  return Boolean(url && serviceRoleKey);
}

function getSupabase() {
  if (!isSupabaseConfigured()) {
    throw new Error(
      "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for the production data provider."
    );
  }

  // This client is server-only. The service-role key never reaches browser
  // code; it is used to perform access-checked database queries and generate
  // short-lived storage URLs for the private bucket.
  return createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false }
  });
}

function requireSupabase(result) {
  if (result.error) throw new Error(result.error.message);
  return result.data;
}

module.exports = { getSupabase, isSupabaseConfigured, requireSupabase };
