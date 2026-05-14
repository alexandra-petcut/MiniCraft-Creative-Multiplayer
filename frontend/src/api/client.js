import axios from "axios";

export const API_URL = import.meta.env.VITE_API_URL || "http://localhost:4000";

export function createApi(token) {
  const api = axios.create({
    baseURL: `${API_URL}/api`
  });

  api.interceptors.request.use((config) => {
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }

    return config;
  });

  return api;
}

export function getErrorMessage(error) {
  return error?.response?.data?.error || error?.message || "Unexpected error.";
}

