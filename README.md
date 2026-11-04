# Should Wear

This is a simple web application that helps users decide what to wear based on the current weather conditions. It provides clothing recommendations for different weather scenarios, ensuring that users are dressed appropriately for their day.

All you need to do to use the app is give it your current location (exact same as normal weather apps) and it will pull the weather data from Open-Meteo (<https://open-meteo.com>) and provide you with a clothing recommendation based on the current temperature, wind chill, and precipitation probability. The app will also show you how the weather is expected to change throughout the day, so you can plan your outfit accordingly.

## Features

- Real-time weather data retrieval using the Open-Meteo API
- Clothing recommendations based on current weather conditions
- Weather forecasts for the day ahead + hourly updates
- Responsive design for mobile and desktop devices
- PWA (Progressive Web App) capabilities for offline access and installation on devices

## Artwork Attribution

Seasonal illustrations use Twemoji SVGs by Twitter and contributors, bundled locally from the [Twemoji project](https://github.com/jdecked/twemoji). The graphics are licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).

## FAQ

- **What is the purpose of this app?**
  The app is designed to help users make informed decisions about what to wear based on the current weather conditions in their location.

- **How does the app determine what to wear?**
  The app uses a combination of current temperature, wind chill, and precipitation probability to provide clothing recommendations. It categorizes clothing into three tiers: Hoodie, Light Jumper, and T-Shirt, with an acceptance bar indicating how suitable each option is.

- **Is the app free to use?**
  Yes, the app is completely free to use and does not require any subscriptions or payments. However, if you want to support the project, [donations](https://github.com/sponsors/JayNightmare) are welcome.

- **Can I use the app offline?**
  Yes, the app is a Progressive Web App (PWA), which means you can install it on your device and access it even when you are offline. However, please note that weather data will not be updated while offline.

- **Where can I find the source code for this app?**
  The source code is available on [GitHub](https://github.com/JayNightmare/ShouldWear).

- **What data does the app store about me?**
  The app does not store any personal data about you. Location data is taken as Postal Code and city name, the application does not contain real-time tracking of your active location outside the app nor within the app while running. The location data is only refreshed when you reopen the app or manually refresh it. The app does not store any other personal information, and all data is processed locally on your device. The only third-party service used is Open-Meteo.
