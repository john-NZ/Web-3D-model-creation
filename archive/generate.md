# Image Generation Script

This project contains `generate.js`, a Node.js script that generates images using the OpenAI Image API.

## Setup

- Run `npm install` to install dependencies (`dotenv`, `openai`)
- API key is stored in `.env` as `OPENAI_API_KEY`
- The script calls the OpenAI REST API directly via `fetch` (not the SDK's image methods, which have validation bugs)

## How the script works

The script has two modes:

### Single image mode
Generate one image from a text prompt, optionally with a reference image:
```bash
node generate.js --prompt "a red chair" --name chair
node generate.js -p "make this blue" -i ./reference.png -n blue-version
```

### Views mode (--views)
Generate back, left, and right views of an object from a reference image in a single command:
```bash
node generate.js --views --image ./reference.png
```
This outputs `back.png`, `left.png`, and `right.png` to the output directory.

## All flags

| Flag | Short | Description | Default |
|------|-------|-------------|---------|
| --prompt | -p | Text prompt | (interactive) |
| --image | -i | Reference image path | (none) |
| --output | -o | Output directory | ./output |
| --name | -n | Output filename (no ext) | timestamp |
| --size | -s | Image dimensions | 1024x1024 |
| --quality | -q | low, medium, high, auto | high |
| --thinking | -t | off, low, medium, high | off |
| --views | -v | Generate back/left/right views | (off) |
| --model | -m | Model name | gpt-image-1.5 |

## Models available

- `gpt-image-1.5` — current default, works without org verification
- `gpt-image-2` — requires OpenAI organization verification
- `gpt-image-1` — supports transparent backgrounds

## Key technical details

- Uses `/v1/images/generations` for text-to-image and `/v1/images/edits` for image+prompt
- Returns base64-encoded PNGs saved to the output directory
- The `openai` npm SDK's `images.generate()` and `images.edit()` methods have a known bug rejecting GPT Image models — this script bypasses the SDK and calls the API directly
- If no flags are provided, the script enters interactive mode and prompts for input
