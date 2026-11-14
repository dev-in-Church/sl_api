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
