# Durhack XI

# Inspiration

Throughout the opening ceremony, we saw various references to the creative arts, from the music software showcased at the event to the urban punk-inspired art direction of its marketing. Naturally, our attention turned towards a musical project. When we learned that the theme was **Composition**, we immediately knew what we wanted to build.

# What it does

Using our proprietary knowledge in hardware, we designed and built a custom controller with unconventional input schemes. This controller serves as the primary input for our rhythm game, giving players the illusion of playing a variety of instruments along to almost any song.

# How we built it

Our team was split into two departments, each tackling its own set of challenges.

**Controller Design**

Our talented hardware engineer, Vlad, combined components from his own robotics kit with equipment from RS's hardware library to bring our controller to life.

At its core, the controller is powered by a Raspberry Pi 5, which processes signals from 4 sensors and translates them into inputs for the game - each sensor is assigned to one of the game’s four tracks. An HC-SR04 ultrasonic sensor tracks hand distance and fires a hit when the hand moves into range, creating a physical “smash” action. TTP223 touch sensor acts as a simple tap button. An MPU6050 gyroscope detects sharp hand twists and converts them into a hit, Bop-It style. An analog joystick read through an ADS7830 ADC provides four directional flicks plus a button press. A Raspberry Pi 5 reads all four sensors and exposes their state through a lightweight Flask HTTP API, which the browser polls at about 20 times per second, applies deadzones, edge detection, and cooldowns, then triggers the corresponding track’s hit, sound, and visual feedback in the game.

**Application Development**

The visual application runs on a custom game engine built using HTML's Canvas API. Since this engine was developed exclusively for our project, we were able to optimise it specifically for our requirements, rather than relying on a general-purpose engine.

The renderer handles everything displayed in the game, including the guitar, incoming notes, hit detection visuals, and special particle effects triggered by specific actions. The game's visual design was brought to life using a spec-driven development approach. We wrote detailed specifications describing how the various elements should look and behave, then passed them to a DeepSeek agent, which generated the corresponding stylesheets.

Alongside the renderer, we developed a custom music engine capable of generating notes based on a song's BPM. To handle instrument separation, we integrated **Demucs using ONNX Runtime Web**, allowing us to run the machine learning model directly in the browser without relying on an external inference server. This lets us isolate individual instrument tracks and generate gameplay around them.

Player input is received from the controller through a custom API endpoint, which the application polls at a consistent interval to keep the gameplay responsive.

# Challenges we ran into

One of our team members' laptops runs a Linux distribution, and unfortunately, early in the hackathon, we encountered issues connecting it to the internet.

This proved to be a significant roadblock for the controller development process, as we were unable to install the necessary software to flash the Raspberry Pi. It delayed progress considerably and forced us to work around some unexpected setup challenges.

# Accomplishments that we're proud of

**We made a controller!**

Jokes aside, we're incredibly proud that we managed to take an idea and turn it into a fully custom hardware controller, integrated with a game engine and music processing pipeline, all within the 24-hour timeframe.

# What we learned

If there's one thing we've learned, it's that **it is foolish to underestimate robotics projects.**

Hardware development comes with a whole different set of challenges compared to software. Things that might take minutes to implement in code can take considerably longer when physical components, wiring, sensors, and device configuration are involved.

# What's next for Durhack Hero?

Looking ahead, one of the biggest improvements would be porting the project to a different rendering architecture.

Given the tight hackathon deadline, we opted for HTML's Canvas API as it offered a quick and accessible way to get our rendering engine up and running. However, running within a web browser inevitably introduces certain limitations and overheads.

For the project's future, migrating to a lower-level graphics API such as OpenGL or Vulkan, potentially using a language like C, would give us much greater control over rendering and performance. This would allow us to push the visual capabilities of the game further, while removing many of the constraints imposed by the browser environment.
