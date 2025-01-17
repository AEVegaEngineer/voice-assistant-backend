require("dotenv").config();
const express = require("express");
const multer = require("multer");
const axios = require("axios");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const wavefile = require("wavefile");
const {
  TranscribeStreamingClient,
  StartStreamTranscriptionCommand,
} = require("@aws-sdk/client-transcribe-streaming");
const app = express();
const http = require("http").createServer(app);
const io = require("socket.io")(http, {
  cors: {
    origin: "http://localhost:3000",
    methods: ["GET", "POST"],
  },
});

const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

const storage = multer.diskStorage({
  destination: "./uploads/",
  filename: (req, file, cb) => {
    cb(null, Date.now() + path.extname(file.originalname));
  },
});

const upload = multer({ storage });

const claudeAPI = axios.create({
  baseURL: "https://api.anthropic.com/v1",
  headers: {
    "x-api-key": process.env.ANTHROPIC_API_KEY,
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
  },
});

const transcribeClient = new TranscribeStreamingClient({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

async function generateClaudeResponse(prompt) {
  try {
    console.log("Sending request to Claude API with prompt:", prompt);
    const response = await claudeAPI.post("/messages", {
      model: "claude-3-sonnet-20240229",
      max_tokens: 1024,
      messages: [{ role: "user", content: prompt }],
    });
    console.log(
      "Received response from Claude API:",
      response.data.content[0].text
    );
    return response.data.content[0].text;
  } catch (error) {
    console.error(
      "Error calling Claude API:",
      error.response ? error.response.data : error.message
    );
    if (error.response) {
      console.error("Status:", error.response.status);
      console.error("Headers:", error.response.headers);
    }
    throw error;
  }
}

async function verifyAudioFile(audioFilePath) {
  console.log("Verifying audio file...");

  try {
    const stats = await fs.promises.stat(audioFilePath);
    if (stats.size === 0) {
      throw new Error("Audio file is empty");
    }
    console.log(JSON.stringify(stats));

    const buffer = await fs.promises.readFile(audioFilePath);
    console.log(`Buffer length: ${buffer.length} bytes`);
    console.log(
      "File header (first 16 bytes):",
      buffer.slice(0, 16).toString("hex")
    );

    let wav;

    try {
      wav = new wavefile.WaveFile(buffer);
    } catch (wavError) {
      console.error("Error creating WaveFile object:", wavError.message);
      // If WaveFile fails, try to read the file as raw PCM data
      return verifyRawPCM(buffer);
    }

    console.log("WAV file details:", {
      sampleRate: wav.fmt.sampleRate,
      bitsPerSample: wav.fmt.bitsPerSample,
      audioFormat: wav.fmt.audioFormat,
      numChannels: wav.fmt.numChannels,
    });

    if (wav.fmt.sampleRate !== 16000) {
      throw new Error(
        `Invalid sample rate: ${wav.fmt.sampleRate}. Expected: 16000 Hz`
      );
    }

    if (wav.fmt.bitsPerSample !== 16) {
      throw new Error(
        `Invalid bits per sample: ${wav.fmt.bitsPerSample}. Expected: 16 bits`
      );
    }

    if (wav.fmt.audioFormat !== 1) {
      throw new Error("Audio is not in PCM format");
    }

    console.log("Audio file verified successfully");
    return true;
  } catch (error) {
    console.error("Error verifying audio file:", error.message);
    return false;
  }
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function transcribeAudio(audioFilePath) {
  console.log("Starting audio transcription...");

  const audio = fs.createReadStream(audioFilePath, {
    highWaterMark: 1024 * 16,
  });

  await sleep(1000);

  const isValidAudio = await verifyAudioFile(audioFilePath);
  if (!isValidAudio) {
    throw new Error(
      `Invalid audio file ${audioFilePath}. Please ensure it's a 16-bit PCM WAV file with 16000 Hz sample rate.`
    );
  }

  const params = {
    LanguageCode: "en-US",
    MediaEncoding: "pcm",
    MediaSampleRateHertz: "16000",
    AudioStream: (async function* () {
      for await (const chunk of audio) {
        yield { AudioEvent: { AudioChunk: chunk } };
      }
    })(),
  };

  const command = new StartStreamTranscriptionCommand(params);

  try {
    console.log("Sending transcribe command");
    const response = await transcribeClient.send(command);
    console.log("Transcribe command sent successfully");
    console.log(JSON.stringify(response, null, 2));

    let transcription = "";
    for await (const event of response.TranscriptResultStream) {
      console.log("Received event:", JSON.stringify(event, null, 2));
      if (event.TranscriptEvent && event.TranscriptEvent.Transcript) {
        const results = event.TranscriptEvent.Transcript.Results;
        if (results && results.length > 0) {
          for (const result of results) {
            if (result.IsPartial === false) {
              for (const alternative of result.Alternatives) {
                transcription += alternative.Transcript + " ";
              }
            }
          }
        }
      }
    }

    console.log("Transcription completed:", transcription.trim());
    return transcription.trim();
  } catch (error) {
    console.error("Error in transcribeAudio:", error);
    throw error;
  }
}

io.on("connection", (socket) => {
  console.log("A user connected");

  socket.on("startConversation", async () => {
    try {
      const prompt =
        "You are a helpful assistant that asks questions on a specific topic. Ask me a question about a random topic.";
      const question = await generateClaudeResponse(prompt);
      socket.emit("question", question);
    } catch (error) {
      console.error("Error generating question:", error);
      socket.emit("error", "Failed to generate question");
    }
  });

  // socket.on("submitAnswer", async (answer) => {
  //   try {
  //     const feedbackPrompt = `Evaluate this answer: ${answer}`;
  //     const feedback = await generateClaudeResponse(feedbackPrompt);
  //     socket.emit("feedback", feedback);

  //     // Generate next question
  //     const nextQuestionPrompt =
  //       "You are a helpful assistant that asks questions on a specific topic. Ask me another question about a random topic.";
  //     const nextQuestion = await generateClaudeResponse(nextQuestionPrompt);
  //     socket.emit("question", nextQuestion);
  //   } catch (error) {
  //     console.error("Error processing answer:", error);
  //     socket.emit("error", "Failed to process answer");
  //   }
  // });

  socket.on("disconnect", () => {
    console.log("User disconnected");
  });
});

app.post("/upload-audio", upload.single("audio"), async (req, res) => {
  if (!req.file) {
    return res.status(400).send("No file uploaded.");
  }

  const audioPath = req.file.path;

  try {
    console.log("Audio file received:", audioPath);
    const transcription = await transcribeAudio(audioPath);
    console.log("Transcription completed:", transcription);
    res.json({ transcription: transcription });
  } catch (error) {
    console.error("Error transcribing audio:", error);
    res.status(500).send("Error transcribing audio: " + error.message);
  } finally {
    fs.unlink(audioPath, (err) => {
      if (err) console.error("Error deleting audio file:", err);
    });
  }
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
  // Application specific logging, throwing an error, or other logic here
});

http.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
