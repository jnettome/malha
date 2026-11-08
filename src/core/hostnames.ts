// Second-level suffixes under a country code, where the registered domain has three labels:
// shop.com.br, shop.co.uk, shop.com.au. A common subset, not the full Public Suffix List.
const TWO_LEVEL = /\.(com|net|org|gov|edu|co|ac|ne|or|art|blog|eco|app)\.[a-z]{2}$/

/** The registered domain a hostname belongs to: api.acme.example → acme.example. */
export function registeredDomain(host: string) {
  const name = host.replace(/^\*\./, '').toLowerCase()
  return name.split('.').slice(TWO_LEVEL.test(name) ? -3 : -2).join('.')
}
