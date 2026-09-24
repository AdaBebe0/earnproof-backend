import { ApiProperty } from "@nestjs/swagger";
import { IsArray, IsIn, ArrayMinSize, ArrayMaxSize } from "class-validator";
import { WEBHOOK_EVENT_TYPES, WebhookEventType } from "../webhook-event.types";

export class UpdateWebhookEventsDto {
  @ApiProperty({
    description: "Replacement set of event type subscriptions",
    type: [String],
    enum: WEBHOOK_EVENT_TYPES,
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(WEBHOOK_EVENT_TYPES.length)
  @IsIn(WEBHOOK_EVENT_TYPES as unknown as string[], { each: true })
  events!: WebhookEventType[];
}
