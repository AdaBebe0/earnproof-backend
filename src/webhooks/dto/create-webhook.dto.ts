import { ApiProperty } from "@nestjs/swagger";
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsUrl,
  MaxLength,
} from "class-validator";
import { FIELD_LIMITS } from "../../common/limits/request-limits";
import { IsSafeUrl } from "../../common/validation/url.validator";
import { WEBHOOK_EVENT_TYPES, WebhookEventType } from "../webhook-event.types";

export class CreateWebhookDto {
  @ApiProperty({
    description: "HTTPS URL that will receive webhook deliveries",
    example: "https://example.com/webhooks/earnproof",
  })
  @IsUrl({ protocols: ["https"], require_tld: true, require_protocol: true })
  @IsSafeUrl()
  @MaxLength(FIELD_LIMITS.url)
  url!: string;

  @ApiProperty({
    description: "Event types to subscribe to",
    type: [String],
    enum: WEBHOOK_EVENT_TYPES,
    example: ["proof.created", "proof.verified"],
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(WEBHOOK_EVENT_TYPES.length)
  @IsIn(WEBHOOK_EVENT_TYPES as unknown as string[], { each: true })
  events!: WebhookEventType[];
}
