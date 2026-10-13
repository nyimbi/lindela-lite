---
library_name: cactus-needle
pipeline_tag: text-generation
license: apache-2.0
tags:
  - tool-calling
  - function-calling
  - on-device
  - edge
  - quantization
  - webassembly
---

![Needle](assets/banner.svg)

A foundation model for mobiles, wearables, robots, smart home, automotive and microcontrollers. The whole model is a single 8-29 MB file, and we trade general chat capacity to beat models 10x its size on mobile tool calls and match 2-3x bigger models on extraction.

Needle does three jobs, all of them on the device:

- **Tool calls**: given the functions your app exposes, Needle picks the right ones and fills every argument from what the user said. Ask for two things and you get two calls in order; ask for something no tool covers and you get an empty list, not a guess.
- **Structured extraction**: declare a shape, hand over messy text, get typed fields back: an invoice, a booking, a notification, a form. The decode grammar guarantees the output parses, and extraction generalises to classification.
- **Text embedding**: the same model returns a vector for a sentence, so an app can search, match and route locally.

The same engine also runs [Whistle](https://huggingface.co/Cactus-Compute/whistle), our 16.9 MB speech-to-text model in seven languages. Load `whistle.cact` beside `needle3.cact` and the one binary transcribes a clip on its own, or answers it against your tools in a single call and returns the calls and the transcript in one JSON object.

## Model

![Needle 3 at a glance](assets/model.svg)

Needle 3 is a Laddered Simple Attention Network, our small-model recipe: a Monarch Hadamard MLP in place of the FFN, GQA attention with causal conv taps, engram n-gram memory read by gather, and multi-lane hyper-connections, trained so that every depth from 2 to 20 layers is a deployable model. Most of its parameters sit in the engram, so the 121M model does the arithmetic of a 50M one. The weights are compressed to CQ2-bit with Cactus Quants; a byte-level grammar compiled from your schemas constrains every token, and every response carries a calibrated confidence score from a learned head. The architecture diagram is on the [release page](https://cactuscompute.com/needle). The repo holds the 20-layer `needle3.cact`, the `needle3.safetensors` checkpoint to fine-tune, and an engine per platform.

## Benchmarks

Tool calling is exact-match accuracy on the full test splits, extraction is field micro-F1 on the full test splits.

![Needle 3 against baselines on six benchmarks](assets/benchmarks.svg)

The interactive frontier plot, the architecture and the fine-tuning results are at [cactuscompute.com/needle](https://cactuscompute.com/needle).

## Get started

```sh
pip install cactus-needle
```

Try it in the browser at [cactuscompute.com/needle](https://cactuscompute.com/needle); the Python package and the source are on [GitHub](https://github.com/cactus-compute/needle).

```python
import needle

@needle.tool
def get_weather(city: str):
    "Get the current weather for a city."
    return {"city": city, "temp_c": 27, "sky": "clear"}

agent = needle.Needle(tools=[get_weather])
print(agent.run("what's it like in Lagos right now?")["results"])
# [{'city': 'Lagos', 'temp_c': 27, 'sky': 'clear'}]
```

Every turn returns one JSON object with `function_calls`, the model's `reasoning` and a calibrated `confidence`; an off-topic request returns an empty list rather than a guess. The engine and the weights are fetched from this repo once and cached.

## Guides

- [How to design tools for Needle 3](https://cactuscompute.com/blog/designing-tools-for-needle): one tool per action, names users would say, formats in descriptions, constraints in the grammar, triggers.
- [Leveraging Needle's confidence](https://cactuscompute.com/blog/needle-confidence): what the score measures, what the engine withholds, and routing on act, confirm or refuse.
- [Structured JSON extraction with Needle](https://cactuscompute.com/blog/structured-extraction-with-needle): the record as the only tool, typed results, classification with enums.
- [Fine-tuning Needle](https://cactuscompute.com/blog/finetuning-needle): the data format, the commands, reading the loss, sizing the dataset.
- [Needle Python docs](https://cactuscompute.com/blog/needle-python-docs): the API, the response shape, the behaviour contract, system facts, tool retrieval, offline devices, environments, the CLI.
- [What devices are supported on Needle](https://cactuscompute.com/blog/needle-supported-devices): every platform folder, the CLI runner, the C API, the browser, WASI, air-gapped setup.
- [The .cact format](https://cactuscompute.com/blog/cact-format): the file the engine maps and reads in place, Cactus Quants at 2.125 bits per weight, and how to parse it yourself.
- [Porting Needle 3](https://cactuscompute.com/blog/porting-needle): notes for writing your own runtime, the oracle to test against, the tensor order the container promises, the prompt on the wire, the ladder rule, retrieval with `needle_embed`.

## Customisation

Needle was designed to be customised. Its capacity is a ladder, and a subnetwork as small as 2 layers, fine-tuned on one product's tools, runs optimally on devices far smaller than the full model needs. Fine-tuning on DroidCall lifts every subnetwork by 18 to 36 points, and from 4 layers up the tuned subnetwork passes DeepSeek V4 Flash, starting at 29M parameters.

![Every subnetwork before and after fine-tuning on DroidCall and on Mobile Actions](assets/finetune.svg)

The Python package fine-tunes with LoRA on the frozen base at the full 20 layers, then `needle build [--layers N]` merges the adapter, slices any subnetwork from 2 to 20 layers and exports a 4-bit `.cact` that runs on the same engine. The 2-bit post-training and quantisation behind the shipped model, enriched with Cactus proprietary datasets, run on the [Cactus Platform](https://cactuscompute.com/dashboard).

## Deploy

Every platform folder in this repo holds an engine that loads `needle3.cact` at start. `needle build --platform <folder> [--layers N]` fetches the engine and header and puts the weights beside them at any depth, or download the folder here:

![One engine per platform folder](assets/deploy.svg)

```sh
./needle --model needle3.cact --tools tools.json --prompt "dim the living room to 30"
./needle --model needle3.cact --tools tools.json --serve

# speech to text, live from a stream, and speech straight to tool calls
./needle --model whistle.cact --audio clip.wav
./needle --model whistle.cact --audio talk.wav --audio-stream
./needle --model needle3.cact --model whistle.cact --tools tools.json --audio clip.wav
```

Tool schemas share the model context with the system prompt and conversation.
`needle_init` returns the tokenized static-prefix length on success and fails
when that prefix does not fit the model context. In the C API, call
`needle_last_error()` after a negative return to get the measured prefix tokens
and context limit. Reduce tool descriptions/schema text, split large catalogues,
or declare more than five tools so Needle can keep only retrieved tools in the
per-turn prefix. At completion time, `max_new_tokens` also reserves context room,
so larger generation caps leave less space for the current turn and history.

The [devices guide](https://cactuscompute.com/blog/needle-supported-devices) covers the runner flags, the C API, the WASI component and air-gapped setup.

## Citation

Needle 3 is built by the Cactus Compute team. If you use it in your work, please cite:

```bibtex
@misc{needle3_2026,
  title        = {Needle: Foundation Tool-Calling Model for Tiny Devices},
  author       = {Ndubuaku, Henry and Mosoyan, Karen and Mroz, Jakub and Cylich, Noah and
                  Kumar, Satyajit and Sandhu, Parkirat and Shemet, Roman and Lee, Justin H.},
  year         = {2026},
  organization = {Cactus Compute, Inc.},
  howpublished = {\url{https://github.com/cactus-compute/needle}}
}
```

Reach out on founders@cactuscompute.com for partnerships, collaborations, synergies and deploying Needle in your product.
