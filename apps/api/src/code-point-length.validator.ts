import { codePointLength } from "@rootline/contracts";
import { buildMessage, type ValidationOptions, ValidateBy } from "class-validator";

export function CodePointLength(
  min: number,
  max: number,
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return ValidateBy(
    {
      name: "codePointLength",
      constraints: [min, max],
      validator: {
        validate: (value): boolean =>
          typeof value === "string"
          && codePointLength(value) >= min
          && codePointLength(value) <= max,
        defaultMessage: buildMessage(
          (eachPrefix) => `${eachPrefix}$property must contain between $constraint1 and $constraint2 Unicode code points`,
          validationOptions,
        ),
      },
    },
    validationOptions,
  );
}
