// Shared phone rules for registration and profile edits.
// 9-15 digits; spaces, dashes, brackets and a leading + are allowed,
// so "0712 345 678" and "+254 712 345 678" both pass.
export const PHONE_REQUIRED_ERROR = "Phone number is required.";
export const PHONE_INVALID_ERROR =
  "Enter a valid phone number, for example 0712 345 678.";

export function validPhone(value) {
  const digits = String(value).replace(/\D/g, "");
  return (
    /^\+?[\d\s\-()]+$/.test(String(value)) &&
    digits.length >= 9 &&
    digits.length <= 15
  );
}

// Kenyan mobile number in the format M-Pesa needs: 2547XXXXXXXX / 2541XXXXXXXX.
// Accepts 0712 345 678, +254 712 345 678, 254712345678, 712345678.
// Returns null if it is not a valid Kenyan mobile number.
export function toMpesaNumber(value) {
  let digits = String(value ?? "").replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.startsWith("254")) digits = digits.slice(3);
  else if (digits.startsWith("0")) digits = digits.slice(1);
  return /^[17]\d{8}$/.test(digits) ? `254${digits}` : null;
}
