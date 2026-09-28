import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { CreateWebhookDto } from "../../src/webhooks/dto/create-webhook.dto";
import { UpdateOrganizationDto } from "../../src/organizations/dto/update-organization.dto";
import { CreateOrganizationDto } from "../../src/organizations/dto/create-organization.dto";

/**
 * Security regression tests for malicious content and unsafe URLs.
 * 
 * Tests representative malicious payloads at backend API boundaries:
 * - HTML fragments and script payloads
 * - Dangerous URL schemes (javascript:, data:, etc.)
 * - Control characters and encoded payloads
 * - Malformed URLs
 * - XSS payloads embedded in otherwise valid fields
 */

describe("Security: Malicious content and URL validation", () => {
  const createValidDto = () => {
    const dto = new CreateWebhookDto();
    dto.url = "https://example.com/webhooks/earnproof";
    dto.events = ["proof.created"];
    return dto;
  };

  describe("Webhook URL validation", () => {
    it("accepts valid HTTPS URLs", async () => {
      const dto = createValidDto();
      const errors = await validate(dto);
      expect(errors).toHaveLength(0);
    });

    it("rejects HTTP URLs", async () => {
      const dto = createValidDto();
      dto.url = "http://example.com/webhooks";
      const errors = await validate(dto);
      expect(errors).toHaveLength(1);
      expect(errors[0].property).toBe("url");
    });

    it("rejects URLs without TLD", async () => {
      const dto = createValidDto();
      dto.url = "https://localhost/webhooks";
      const errors = await validate(dto);
      expect(errors).toHaveLength(1);
      expect(errors[0].property).toBe("url");
    });

    it("rejects javascript: URLs", async () => {
      const dto = createValidDto();
      dto.url = "javascript:alert('xss')";
      const errors = await validate(dto);
      expect(errors).toHaveLength(1);
      expect(errors[0].property).toBe("url");
    });

    it("rejects data: URLs", async () => {
      const dto = createValidDto();
      dto.url = "data:text/html,<script>alert('xss')</script>";
      const errors = await validate(dto);
      expect(errors).toHaveLength(1);
      expect(errors[0].property).toBe("url");
    });

    it("rejects URLs with HTML fragments in path", async () => {
      const dto = createValidDto();
      dto.url = "https://example.com/<script>alert('xss')</script>";
      const errors = await validate(dto);
      expect(errors).toHaveLength(1);
      expect(errors[0].property).toBe("url");
    });

    it("rejects URLs with event handlers in query params", async () => {
      const dto = createValidDto();
      dto.url = "https://example.com/webhooks?param=value' onload='alert(1)";
      const errors = await validate(dto);
      expect(errors).toHaveLength(1);
      expect(errors[0].property).toBe("url");
    });

    it("rejects URLs with control characters", async () => {
      const dto = createValidDto();
      dto.url = "https://example.com/webhooks\u0000evil";
      const errors = await validate(dto);
      expect(errors).toHaveLength(1);
      expect(errors[0].property).toBe("url");
    });

    it("rejects extremely long URLs", async () => {
      const dto = createValidDto();
      dto.url = `https://example.com/${"a".repeat(3000)}`;
      const errors = await validate(dto);
      expect(errors).toHaveLength(1);
      expect(errors[0].property).toBe("url");
    });

    it("rejects encoded malicious payloads", async () => {
      const dto = createValidDto();
      dto.url = "https://example.com/%3Cscript%3Ealert('xss')%3C%2Fscript%3E";
      const errors = await validate(dto);
      expect(errors).toHaveLength(1);
      expect(errors[0].property).toBe("url");
    });

    it("rejects private IP addresses", async () => {
      const testCases = [
        "https://192.168.1.1/webhooks",
        "https://10.0.0.1/webhooks",
        "https://172.16.0.1/webhooks",
        "https://127.0.0.1/webhooks",
        "https://0.0.0.0/webhooks",
      ];

      for (const url of testCases) {
        const dto = createValidDto();
        dto.url = url;
        const errors = await validate(dto);
        expect(errors).toHaveLength(1);
        expect(errors[0].property).toBe("url");
      }
    });

    it("accepts valid public IP addresses", async () => {
      const dto = createValidDto();
      dto.url = "https://8.8.8.8/webhooks";
      const errors = await validate(dto);
      expect(errors).toHaveLength(0);
    });
  });

  describe("Organization website URL validation", () => {
    const createValidUpdateDto = () => {
      const dto = new UpdateOrganizationDto();
      dto.name = "Test Org";
      return dto;
    };

    const createValidCreateDto = () => {
      const dto = new CreateOrganizationDto();
      dto.name = "Test Org";
      dto.slug = "test-org";
      return dto;
    };

    it("accepts valid HTTPS URLs for website", async () => {
      const dto = createValidUpdateDto();
      dto.website = "https://example.com";
      const errors = await validate(dto);
      expect(errors).toHaveLength(0);
    });

    it("accepts valid HTTP URLs for website (less strict than webhooks)", async () => {
      const dto = createValidUpdateDto();
      dto.website = "http://example.com";
      const errors = await validate(dto);
      expect(errors).toHaveLength(0);
    });

    it("rejects dangerous URL schemes in website field", async () => {
      const dto = createValidUpdateDto();
      dto.website = "javascript:alert('xss')";
      const errors = await validate(dto);
      expect(errors).toHaveLength(1);
      expect(errors[0].property).toBe("website");
    });

    it("rejects malformed URLs in website field", async () => {
      const dto = createValidUpdateDto();
      dto.website = "not-a-url";
      const errors = await validate(dto);
      expect(errors).toHaveLength(1);
      expect(errors[0].property).toBe("website");
    });

    it("allows website to be optional", async () => {
      const dto = createValidUpdateDto();
      const errors = await validate(dto);
      expect(errors).toHaveLength(0);
    });

    it("validates website field in CreateOrganizationDto", async () => {
      const dto = createValidCreateDto();
      dto.website = "https://example.com";
      const errors = await validate(dto);
      expect(errors).toHaveLength(0);
    });

    it("rejects malicious website in CreateOrganizationDto", async () => {
      const dto = createValidCreateDto();
      dto.website = "data:text/html,<script>evil</script>";
      const errors = await validate(dto);
      expect(errors).toHaveLength(1);
      expect(errors[0].property).toBe("website");
    });
  });

  describe("String field validation for XSS payloads", () => {
    // Test DTOs that have string fields which could contain malicious content
    // These are representative tests for fields that might accept user input

    it("should test organization name field for script payloads", async () => {
      const dto = plainToInstance(UpdateOrganizationDto, {
        name: "Test Org<script>alert('xss')</script>",
      });

      const errors = await validate(dto);
      // Note: class-validator's @IsString doesn't reject script tags by default
      // This test documents that we're aware of the limitation
      expect(errors).toHaveLength(0); // Currently passes - need enhanced validation if this is a concern
    });

    it("should test organization slug field for dangerous characters", async () => {
      const dto = plainToInstance(CreateOrganizationDto, {
        name: "Test Org",
        slug: "test-org<script>", // Should fail @Matches pattern
      });

      const errors = await validate(dto);
      expect(errors).toHaveLength(1);
      expect(errors[0].property).toBe("slug");
    });
  });

  describe("Validation of array fields with string elements", () => {
    it("should validate each element in webhook events array", async () => {
      const dto = plainToInstance(CreateWebhookDto, {
        url: "https://example.com/webhooks",
        events: ["proof.created", "invalid.event"], // invalid.event should fail
      });

      const errors = await validate(dto);
      expect(errors).toHaveLength(1);
      expect(errors[0].property).toBe("events");
    });

    it("should reject arrays with non-string elements", async () => {
      const dto = plainToInstance(CreateWebhookDto, {
        url: "https://example.com/webhooks",
        events: ["proof.created", 123 as any], // TypeScript cast to bypass type checking
      });

      const errors = await validate(dto);
      expect(errors).toHaveLength(1);
      expect(errors[0].property).toBe("events");
    });
  });

  describe("Edge cases and encoded payloads", () => {
    it("rejects double-encoded malicious URLs", async () => {
      const dto = createValidDto();
      // Double-encoded script tag
      dto.url = "https://example.com/%253Cscript%253Ealert('xss')%253C%252Fscript%253E";
      const errors = await validate(dto);
      expect(errors).toHaveLength(1);
      expect(errors[0].property).toBe("url");
    });

    it("rejects URLs with null bytes", async () => {
      const dto = createValidDto();
      dto.url = "https://example.com/\0evil";
      const errors = await validate(dto);
      expect(errors).toHaveLength(1);
      expect(errors[0].property).toBe("url");
    });

    it("rejects URLs with newlines and carriage returns", async () => {
      const testCases = [
        "https://example.com/\nwebhooks",
        "https://example.com/\rwebhooks",
        "https://example.com/\r\nwebhooks",
      ];

      for (const url of testCases) {
        const dto = createValidDto();
        dto.url = url;
        const errors = await validate(dto);
        expect(errors).toHaveLength(1);
        expect(errors[0].property).toBe("url");
      }
    });

    it("rejects URLs with suspicious characters in hostname", async () => {
      const testCases = [
        "https://example$.com/webhooks",
        "https://example|.com/webhooks",
        "https://example\".com/webhooks",
        "https://example'.com/webhooks",
        "https://example<.com/webhooks",
        "https://example>.com/webhooks",
      ];

      for (const url of testCases) {
        const dto = createValidDto();
        dto.url = url;
        const errors = await validate(dto);
        expect(errors).toHaveLength(1);
        expect(errors[0].property).toBe("url");
      }
    });
  });
});
